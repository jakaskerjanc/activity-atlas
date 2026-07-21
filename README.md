# Strava on Maps

All your Strava activities as routes on one interactive Mapbox map, filterable
by type and date. A weekly GitHub Action syncs activities, builds a compact
track file, and deploys a static site to GitHub Pages.

## How it works

Two scripts turn Strava data into the map, run in sequence:

```
Strava API ──▶ sync.ts ──▶ data/activities.json ──▶ build-tracks.ts ──▶ tracks.json ──▶ site
```

**`sync.ts`** talks to the Strava API and updates the local cache,
`data/activities.json`:

1. It fetches the activity list, but only activities created since the
   previous run — the cache is committed, so nothing is re-fetched. The list
   endpoint is cheap: it returns a `summary_polyline` for every activity at
   roughly 1 API call per 200 activities.
2. It also backfills a higher-resolution `detail_polyline` for activities
   that don't have one yet, one API call each. This is throttled to
   `DETAIL_LIMIT` per run (default 190) to stay under Strava's
   200-requests-per-15-minutes rate limit — a large backlog backfills over
   several runs rather than in one.

**`build-tracks.ts`** then reads that cache and writes
`app/public/tracks.json`, simplifying each route with Douglas–Peucker
(`SIMPLIFY_TOLERANCE_M`, default 5 m) and shipping it as a Google-encoded
polyline rather than a decoded GeoJSON coordinate array — roughly half the
payload and a much cheaper parse. The frontend fetches this static file and
decodes the polylines back into map geometry (`app/src/tracks.ts`) — no Strava
API calls happen in the browser.

## Config

Add these to a root `.env` (see `.example.env`):

- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REFRESH_TOKEN`
- `VITE_MAPBOX_TOKEN`

## Setting up your own copy

Use this if you've cloned/forked the repo to run it against your own Strava
account.

### 1. Fork and clone

```bash
gh repo fork <owner>/strava-on-maps --clone
cd strava-on-maps
npm install
cp .example.env .env
```

### 2. Create a Strava API app

Go to <https://www.strava.com/settings/api> and create an app with
**Authorization Callback Domain** set to `localhost`. Note the Client ID and
Client Secret, and add them to `.env`.

### 3. Get a Strava refresh token (OAuth)

```bash
npm run auth   # starts a local server on :8080
```

This prints an authorize URL — open it in your browser, log into Strava, and
approve access (scope: `activity:read_all`). Strava redirects back to
`localhost:8080`, the script exchanges the code for a token, and prints
`STRAVA_REFRESH_TOKEN` in the terminal. Add it to `.env`.

### 4. Create a Mapbox token

Create a **public** token at <https://account.mapbox.com/access-tokens/>,
restricted by URL to your GitHub Pages domain. Add it to `.env` as
`VITE_MAPBOX_TOKEN`.

### 5. Do a local backfill

Run this locally first so the initial full history doesn't spread over
several weekly CI runs — repeat every ~15 min until it reports "0 remaining"
(≈ N/190 runs, per Strava's rate limit):

```bash
npm run sync
```

This writes/updates `data/activities.json`, which you should commit.

### 6. Push secrets to GitHub Actions

Using the [GitHub CLI](https://cli.github.com/):

```bash
gh secret set -f .env
```

Or set them individually:

```bash
gh secret set STRAVA_CLIENT_ID -b"xxx"
gh secret set STRAVA_CLIENT_SECRET -b"yyy"
gh secret set STRAVA_REFRESH_TOKEN -b"zzz"
gh secret set VITE_MAPBOX_TOKEN -b"pk.xxx"
```

### 7. Enable Pages and run the workflow

- Settings → Pages → Source = GitHub Actions.
- Run **Sync & Deploy** manually once (Actions tab). It then runs weekly
  (Mon 04:00 UTC) on its own.

## Local development

Once `.env` is populated (see setup above):

```bash
npm install
npm run sync            # refresh data/activities.json from Strava
npm run build:tracks    # regenerate app/public/tracks.json
npm --workspace app run dev
```

`npm run sync` and `npm run build:tracks` only need to be re-run when
Strava data changes — for day-to-day frontend work, `npm --workspace app run
dev` alone is enough.
