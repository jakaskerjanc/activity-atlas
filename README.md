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
database of deduped activities from Strava and Garmin bulk exports.

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
bulk data exports (not committed — only the resulting DB is):

```bash
npm run import:strava -- <path-to-strava-export>
npm run import:garmin -- <path-to-garmin-export>
```

Run Strava first, then Garmin — the Garmin importer dedupes against
already-imported Strava activities (±90 s start time, ±5% distance) and
prefers the higher-resolution GPS source when both cover the same activity.
Both importers write into the same `data/activities.sqlite`, which you
should commit afterward.

Ongoing incremental fetch from the Garmin Connect Personal API
(`ingest/garmin_fetch.py`) keeps the database current after the backfill — see
[Live Garmin fetch](#live-garmin-fetch).

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

Save the key in the default location:

```bash
mkdir -p ~/.config/garmin
$EDITOR ~/.config/garmin/connect-personal-api-key   # paste the key
chmod 600 ~/.config/garmin/connect-personal-api-key
npm run fetch:garmin
```

Alternatively export `GARMIN_PERSONAL_API_KEY`. Credentials resolve in this
order: an explicit `--api-key-file PATH`, then `GARMIN_PERSONAL_API_KEY`, then
`~/.config/garmin/connect-personal-api-key`. The fetch appends new activities
to `data/activities.sqlite`; commit the DB afterward.

### CI

`.github/workflows/fetch-garmin.yml` runs daily: fetch via the Personal API →
commit the DB if it changed → push, which retriggers `deploy.yml`. Each run
exchanges the key for a fresh 24-hour token, so there is no token rotation and
no `gh secret set` step during the run.

**Secrets:**

- `GARMIN_PERSONAL_API_KEY` — the Personal API key from above.
- `GH_PAT` — fine-grained, this repo, **contents: write only**. The PAT push is
  what retriggers `deploy.yml` (`GITHUB_TOKEN` pushes would not).

### Renewing the key

When the key expires (30/90/180/365 days after creation), the daily fetch fails
with exit code 3. Create a new key at Garmin Connect → **Settings** →
**Personal API Key**, update `~/.config/garmin/connect-personal-api-key` (or
the environment variable), and replace the repository secret:

```bash
gh secret set GARMIN_PERSONAL_API_KEY -b"<new key>"
```

Only the expired key is replaced; nothing else rotates.

## Config

Add these to a root `.env` (see `.example.env`):

- `VITE_MAPBOX_TOKEN`

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
npm run import:strava -- <path-to-strava-export>
npm run import:garmin -- <path-to-garmin-export>
```

This creates/updates `data/activities.sqlite`, which you should commit.

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
