# Strava on Maps

All your Strava activities as routes on one interactive Mapbox map, filterable
by type and date. A weekly GitHub Action syncs activities, builds a GeoJSON
file, and deploys a static site to GitHub Pages.

## How it works

```
Strava API ─(sync.ts)─▶ data/activities.json ─(build-geojson.ts)─▶ activities.geojson ─▶ site
```

- Incremental: cache is committed, so each run only fetches new activities.
- Cheap: activity list uses `summary_polyline` (~1 API call / 200 activities).
- Detail: each run also backfills `detail_polyline` (capped at `DETAIL_LIMIT`,
  default 190/run, to stay under Strava's 200 req/15 min limit), simplified
  with Douglas–Peucker (`SIMPLIFY_TOLERANCE_M`, default 5 m).

## One-time setup

1. Create a Strava API app at <https://www.strava.com/settings/api>
   (Authorization Callback Domain = `localhost`). Note Client ID/Secret.
2. Get a refresh token (needs `activity:read_all`):
   ```bash
   npm install
   STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy npm run auth
   ```
3. Create a **public** Mapbox token at <https://account.mapbox.com/access-tokens/>,
   restricted by URL to your Pages domain.
4. Add repo secrets: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
   `STRAVA_REFRESH_TOKEN`, `VITE_MAPBOX_TOKEN`.
5. Enable GitHub Pages: Settings → Pages → Source = GitHub Actions.
6. Backfill detail polylines locally first, so it doesn't spread over several
   weekly runs — repeat every ~15 min until "0 remaining" (≈ N/190 runs):
   ```bash
   STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy STRAVA_REFRESH_TOKEN=zzz npm run sync
   ```
7. Run **Sync & Deploy** manually once (Actions tab). It then runs weekly
   (Mon 04:00 UTC) on its own.

## Local development

```bash
npm install
STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy STRAVA_REFRESH_TOKEN=zzz npm run sync
npm run build:geojson
VITE_MAPBOX_TOKEN=pk.xxx npm --workspace app run dev
```
