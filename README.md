# Strava on Maps

Visualize all your Strava activities as routes on one big interactive MapBox map,
with filtering by activity type and date. A scheduled GitHub Action fetches your
activities, processes them into a single GeoJSON file, and deploys a static site
to GitHub Pages.

## How it works

```
Strava API ──(scripts/sync.ts, incremental)──▶ data/activities.json   (committed cache)
                                                       │
                            (scripts/build-geojson.ts, decode polylines)
                                                       ▼
                                        app/public/activities.geojson  (build artifact)
                                                       │
                                     (vite build) ─────▶ static site ──▶ GitHub Pages
```

- **Incremental fetch:** the cache is committed to the repo, so each run only
  fetches activities newer than the last sync (first run backfills everything).
- **Cheap:** the activity list uses Strava's `summary_polyline` — roughly one API
  call per 200 activities.
- **Detailed tracks:** each run also backfills a full-resolution `detail_polyline`
  (one detail call per activity, capped at `DETAIL_LIMIT`, default 190/run to stay
  under the 200 req/15 min read limit). `build-geojson.ts` prefers the detail line,
  simplified with Douglas–Peucker (`SIMPLIFY_TOLERANCE_M`, default 5 m), and falls
  back to the summary for not-yet-detailed activities. The full detail stays on
  disk, so the tolerance can be re-tuned without re-fetching.

### Initial detail backfill

The first `detail_polyline` backfill is a one-time job; do it locally so it
doesn't spread over several daily CI runs:

```bash
# Repeat every ~15 min until it reports "0 remaining" (≈ N/190 runs).
STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy STRAVA_REFRESH_TOKEN=zzz npm run sync
```

The refresh token needs `activity:read_all` scope (what `npm run auth` requests).

## One-time setup

1. **Create a Strava API app** at <https://www.strava.com/settings/api>.
   Set **Authorization Callback Domain** to `localhost`. Note the **Client ID**
   and **Client Secret**.

2. **Get a refresh token** (locally):

   ```bash
   npm install
   STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy npm run auth
   ```

   Open the printed URL, authorize, and copy the `STRAVA_REFRESH_TOKEN` it prints.

3. **Create a Mapbox token** at <https://account.mapbox.com/access-tokens/> — a
   **public** token restricted by URL to your Pages domain (it ships in the client
   bundle, so restriction is your protection).

4. **Add repo secrets** (Settings → Secrets and variables → Actions):
   `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`,
   `VITE_MAPBOX_TOKEN`.

5. **Enable GitHub Pages:** Settings → Pages → Source = **GitHub Actions**.

6. Run the **Sync & Deploy** workflow manually (Actions tab → Run workflow) for
   the first backfill, then it runs daily on its own.

## Local development

```bash
npm install

# Fetch your activities into data/activities.json
STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=yyy STRAVA_REFRESH_TOKEN=zzz npm run sync

# Build the GeoJSON the app consumes
npm run build:geojson

# Run the app
VITE_MAPBOX_TOKEN=pk.xxx npm --workspace app run dev
```

## Project layout

| Path | Purpose |
|------|---------|
| `scripts/sync.ts` | Incremental Strava fetch (summary + detail) → `data/activities.json` |
| `scripts/build-geojson.ts` | Decode + simplify polylines → `app/public/activities.geojson` |
| `scripts/simplify.ts` | Douglas–Peucker line simplification (unit-tested) |
| `scripts/get-refresh-token.ts` | One-time OAuth helper (`npm run auth`) |
| `scripts/types.ts` | Shared cache + GeoJSON-property types (data contract) |
| `app/src/MapView.tsx` | Owns the Mapbox map, route layer, and filter application |
| `app/src/filters.ts` | `FilterState` + Mapbox filter-expression builder |
| `app/src/ui/` | **Stub** controls — to be replaced by a Claude Design UI |
| `.github/workflows/deploy.yml` | Cron + manual: sync → commit → build → deploy |

## Data contract

Each feature in `activities.geojson` is a `LineString` with these properties
(see `scripts/types.ts` / `app/src/types.ts`). The future UI should rely only on
these:

`id`, `name`, `type` (activity type), `ts` (epoch **seconds**, for date filtering),
`start_date` (ISO), `distance` (m), `moving_time` (s), `elevation_gain` (m).
