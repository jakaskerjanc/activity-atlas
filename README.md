# Strava on Maps

**[Live site →](https://jakaskerjanc.github.io/strava-on-maps/)**

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

Ongoing incremental fetch from the Garmin Connect API (`ingest/garmin_fetch.py`)
is a later phase — for now it's a stub.

## Live Garmin fetch

One-time token bootstrap (interactive; needs email + password + MFA):

```bash
npm run --silent auth | gh secret set GARMIN_TOKEN   # also dumps ~/.garminconnect for local reuse
# --silent is required: without it, npm's "> pkg@ver auth" banner leaks into
# stdout and corrupts the piped secret (silent JSON-parse failure in CI).
```

Local incremental fetch (token-only; appends new activities to `data/activities.sqlite`):

```bash
GARMINTOKENS=$HOME/.garminconnect npm run fetch:garmin
```

CI (`.github/workflows/fetch-garmin.yml`) runs daily: fetch → rotate `GARMIN_TOKEN`
(the refresh token rotates on use) → commit the DB, which retriggers deploy.
Rerun `npm run auth` only after a password change or token revocation.

**Secrets:** `GARMIN_TOKEN` (from `npm run auth`) and `GH_PAT`
(fine-grained, this repo, **contents: write + secrets: write** — the PAT push is
what retriggers `deploy.yml`, and secrets:write lets CI rotate the token).

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
restricted by URL to your GitHub Pages domain. Add it to `.env` as
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
