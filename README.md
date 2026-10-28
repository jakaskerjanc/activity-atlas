# Strava on Maps

**[Live site →](https://strava-map.jakas.si/)**

All your Strava and Garmin activities as routes on one interactive Mapbox
map, filterable by type and date. A GitHub Action builds a compact track file
from the committed activity database and deploys a static site to GitHub
Pages on every push.

## How it works

```
data/activities.sqlite ──▶ build-tracks.ts ──▶ app/public/tracks.json ──▶ site
```

`data/activities.sqlite` is the committed source of truth — a SQLite
database of deduped activities from Strava and Garmin, built from bulk exports
and kept current by the ongoing Garmin live fetch.

**`build-tracks.ts`** reads that database and writes `app/public/tracks.json`,
simplifying each route with Douglas–Peucker (`SIMPLIFY_TOLERANCE_M`, default
5 m) and shipping it as a Google-encoded polyline rather than a decoded
GeoJSON coordinate array — roughly half the payload and a much cheaper parse.
The frontend fetches this static file and decodes the polylines back into map
geometry (`app/src/tracks.ts`) — no Strava/Garmin API calls happen in the
browser.

`npm run build` runs `build:tracks` then the app build, so CI needs no
network access or secrets beyond the Mapbox token — it just reads the
committed DB.

## Populating the database

Activities get into `data/activities.sqlite` via a one-shot backfill from
bulk data exports. Pass each export **zip** as downloaded:

```bash
npm run import:strava -- <strava-export.zip>
npm run import:garmin -- <garmin-export.zip>
```

Each import first stores the zip byte for byte, plus every file it reads
(activity files, `activities.csv`, `*summarizedActivities.json`), in the
archive at `ARCHIVE_URL` (default `file://data/archive`, gitignored). It then
parses full-resolution streams, laps and gear into the database. An unzipped
export folder also works, for development, but then no export archive is
stored (the importer warns). Re-running an import changes nothing. A newer
export that lacks an activity inside its date range marks that record
deleted; nothing is removed.

Run Strava first, then Garmin. Each provider record joins an existing
activity when their time ranges overlap by at least 50% of the shorter range
(or, when either side has no elapsed time, when their starts are within
±180 s). A match is rejected when both sides have GPS and their distances
differ by more than 20%. Two records from the same provider never merge, and a
type mismatch only logs a warning. Strava's values win on merged activities;
Garmin fills the gaps. Both importers write into the same database.

**Do not commit the new database.** It holds full-resolution GPS, heart rate
and the raw export rows (including private notes). Until the storage cutover,
the committed `data/activities.sqlite` stays the old v1 database that the
site and the daily fetch use, and every new writer refuses it (exit code 4).
Point `--db` at a scratch path instead, for example
`--db data/v2.sqlite`.

Ongoing incremental fetch from the Garmin Connect Personal API
(`ingest/garmin_fetch.py`) keeps the database current after the backfill — see
[Live Garmin fetch](#live-garmin-fetch).

## Rebuild

```bash
npm run rebuild -- [--db data/activities.sqlite] [--archive file://data/archive]
```

Rebuilds the database from the archive's source records. If any activity in
the database has no record in the archive (a wrong `--archive` path, for
example), the rebuild stops without changing anything; `--force` rebuilds
anyway and those activities lose their data. Each activity keeps
its ID: the rebuild carries over only the identity of each provider record
(which activity it belongs to, manual pins, deletions) and the hidden flags,
and re-derives everything else. Rebuilding twice gives the same rows. The
importers and the fetch run a rebuild by themselves when the database has an
older v2 schema. They refuse a v1 database (exit code 4): import fresh exports
into a new database instead.

## Manual fixes

When the matcher gets an activity wrong, fix it by hand:

```bash
npm run activity -- merge <keep-id> <other-id>          # one activity, recorded twice
npm run activity -- split <id> garmin:<garmin-activity-id>   # two activities merged by mistake
npm run activity -- hide <id>                           # keep it, but leave it off the site
npm run activity -- unhide <id>
```

Each command takes `--db PATH` (default `data/activities.sqlite`). Merged and
split sources are pinned, so later imports, fetches and rebuilds keep them as
you set them. Hidden activities stay in the database.

## Live Garmin fetch

`ingest/garmin_fetch.py` pulls new activities through Garmin's official
[Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/)
instead of the unofficial `garminconnect` scraper. The official API needs no
password or MFA login and no rotating token blob — just one personal API key,
which the client exchanges for a 24-hour bearer token on each run.

### Create a Personal API key (one time)

1. Open Garmin Connect → **Settings** → **Personal API Key**.
2. Pick a lifetime: **30, 90, 180 or 365 days**.
3. Copy the key — Garmin shows it only once.

The key is not permanent. When it expires, Garmin rejects it and the fetch exits
with code 3; create a fresh key the same way and replace the old one locally
and in CI (see [Renewing the key](#renewing-the-key)).

### Local setup

Add the key to the root `.env` (gitignored; see [Config](#config)):

```bash
GARMIN_PERSONAL_API_KEY=<your key>
```

then run `npm run fetch:garmin`. Credentials resolve in this order: an explicit
`--api-key-file PATH`, then a `GARMIN_PERSONAL_API_KEY` environment variable,
then `GARMIN_PERSONAL_API_KEY` in `.env`. If no key is found, the fetch exits
with code 2. The fetch stores every list page, activity ZIP and activity file
in the archive (`ARCHIVE_URL`, `--archive`), then adds the new activities to
the database (`--db`; see the warning in
[Populating the database](#populating-the-database) about not committing it).

### CI

`.github/workflows/fetch-garmin.yml` runs daily: fetch via the Personal API →
commit the DB if it changed → push, which retriggers `deploy.yml`. Each run
exchanges the key for a fresh 24-hour token, so there is no token rotation and
no `gh secret set` step during the run.

**Secrets:**

- `GARMIN_PERSONAL_API_KEY` — the Personal API key from above.
- `GH_PAT` — fine-grained, this repo, **contents: write only**. The PAT push is
  what retriggers `deploy.yml` (`GITHUB_TOKEN` pushes would not).

Set the secret without putting the key in shell history:

```bash
gh secret set GARMIN_PERSONAL_API_KEY    # paste the key at the prompt
```

The workflow no longer writes any secrets, so `GH_PAT` needs no `secrets: write`
permission.

### Renewing the key

When the key expires (30/90/180/365 days after creation), the daily fetch fails
with exit code 3. Create a new key at Garmin Connect → **Settings** →
**Personal API Key**, update `GARMIN_PERSONAL_API_KEY` in `.env`, and replace
the repository secret:

```bash
gh secret set GARMIN_PERSONAL_API_KEY    # paste the new key at the prompt
```

Only the expired key is replaced; nothing else rotates.

## Config

Add these to a root `.env` (see `.example.env`):

- `VITE_MAPBOX_TOKEN`
- `GARMIN_PERSONAL_API_KEY` — only needed for the [live Garmin fetch](#live-garmin-fetch)

## Setting up your own copy

Use this if you've cloned/forked the repo to run it against your own
activity history.

### 1. Fork and clone

```bash
gh repo fork <owner>/strava-on-maps --clone
cd strava-on-maps
npm install
cp .example.env .env
```

### 2. Create a Mapbox token

Create a **public** token at <https://account.mapbox.com/access-tokens/>,
restricted by URL to the domain you serve the site from
(e.g. `https://strava-map.jakas.si`). Add it to `.env` as
`VITE_MAPBOX_TOKEN`.

### 3. Export and import your activity history

Export your bulk activity data from Strava (Settings → My Account → Download
or Delete Your Account → Download Request) and/or Garmin Connect (Account
Settings → Export Your Data), then run the importers:

```bash
npm run import:strava -- <strava-export.zip>
npm run import:garmin -- <garmin-export.zip>
```

Add `--db data/v2.sqlite` to both commands. This archives the exports under
`data/archive/` (gitignored) and creates the new database. Don't commit it
(see [Populating the database](#populating-the-database)).

### 4. Push secrets to GitHub Actions

```bash
gh secret set VITE_MAPBOX_TOKEN -b"pk.xxx"
```

### 5. Enable Pages and run the workflow

- Settings → Pages → Source = GitHub Actions.
- Optional: set a custom domain under Settings → Pages (this site uses
  `strava-map.jakas.si`, a CNAME to `<user>.github.io`) and enable
  **Enforce HTTPS**.
- Push to `main` (or run **Deploy** manually from the Actions tab) to build
  and deploy.

## Local development

```bash
npm install
npm run build:tracks    # regenerate app/public/tracks.json from the DB
npm --workspace app run dev
```

`npm run build:tracks` only needs to be re-run when the activity database
changes (e.g. after an import) — for day-to-day frontend work,
`npm --workspace app run dev` alone is enough.
