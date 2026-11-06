# Demo data

Synthetic activities so a fresh fork has a working site before any import.
Nothing here comes from a real person.

- **`routes.json`** (`v: 1`) — base routes around Maribor, Slovenia. Their
  geometry was routed along OpenStreetMap paths by the public FOSSGIS OSRM
  server, and their elevation comes from Open-Meteo's Copernicus DEM. Each
  point is `[lat, lon, elevation_m]`, densified to about 50 m. Regenerate with
  `python -m ingest.demo.routes` (network, one-off, resumable).
- **`activities.sqlite`** — about 100 made-up Strava activities over
  2025-08 → 2026-11, generated from the routes by `ingest/demo/build.py` and
  imported through the real `ingest.strava_import` code path. It contains
  streams from GPX data, heart rate, cadence and power, plus a few indoor gym
  sessions without GPS. Fixed seed: rebuilding gives the same activity IDs and
  numbers.

`build-tracks.ts` and `scripts/ci_db.sh` use this database when
`data/activities.sqlite` (the personal one) does not exist, so the demo is what
a fork deploys until it imports its own data.

Regenerate the database after changing the routes or the generator:

```bash
pnpm run build:demo
```

The source of truth is `routes.json`; the builder never reads the personal
database or archive.

Do not run `pnpm run rebuild` against this database: its source archive lives
only in the builder's temporary directory, by design. Regenerate it with
`pnpm run build:demo` instead.
