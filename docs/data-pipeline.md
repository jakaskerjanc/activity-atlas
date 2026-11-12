# Data pipeline

How activities get from the exports into the database, and from the database
onto the site. For the overview, see the [README](../README.md#how-it-works).

## Importing exports

Pass each export **zip** as downloaded, Strava first:

```bash
pnpm run import:strava <strava-export.zip>
pnpm run import:garmin <garmin-export.zip>
```

Each import stores the zip and every file it reads byte for byte in the
archive (`ARCHIVE_URL`, default `file://data/archive`, gitignored), then
parses streams, laps and gear into the database. The Garmin import also stores
the export's all-day monitoring data as wellness data. Of that, only the daily
step totals are published.

- Re-running an import changes nothing.
- A newer export that lacks an activity inside its date range marks that
  record deleted; nothing is removed.
- Exports are ordered by when they were made, so importing an older export
  never replaces newer data.
- With R2, the first import needs `--init-db` (see
  [publishing](publishing.md)). After the backfill, the Garmin fetch keeps the
  database current.

**Never commit the database.** It holds full-resolution GPS, heart rate and
the raw export rows, including private notes; `data/*` is gitignored.

## Matching Strava and Garmin

A Garmin record joins an existing Strava activity when their times overlap
substantially (or, without elapsed time, their starts are within a few
minutes) and, when both have GPS, their distances roughly agree. Two records
from the same provider never merge. Strava's values win; Garmin fills the gaps.
The exact thresholds are in `ingest/matcher.py`.

## Manual fixes

When the matcher gets an activity wrong:

```bash
pnpm run activity merge <keep-id> <other-id>          # one activity, recorded twice
pnpm run activity split <id> garmin:<garmin-activity-id>   # two merged by mistake
pnpm run activity hide <id>                           # keep it, but leave it off the site
pnpm run activity unhide <id>
```

Merged and split sources are pinned, so later imports, fetches and rebuilds
keep them as you set them. Hidden activities stay in the database.

## Places and same routes

After every job that writes the database (an import, the Garmin fetch, a
rebuild, `pnpm run activity`, `places:update`), the run recomputes the places
(where activities climbed to), the same-route groups and their names. Only
visible activities are grouped. If that refresh fails, the job's own work is
still saved (and uploaded to R2) with the previous places and routes, and the
run exits with code 7.

Names come from OpenStreetMap points. Download them once per country:

```bash
pnpm run places:update SI AT
```

For each country (ISO 3166-1 codes) it asks Overpass for the named peaks,
passes, parks, lakes and other water, and neighbourhoods up to villages,
stores the raw response in the archive under `osm/<CC>/`, and replaces that
country's points in the database. All countries are downloaded first: if any fails (an
HTTP error, a timeout, no network) it stops before writing anything. Without
OSM points, places are named "Top at … m" and routes by distance and shape
("5.2 km loop").

Big countries take minutes each: Austria about 3, Norway about 6 (a 28 MB
reply, mostly named lakes). The public Overpass server is often busy: an HTTP
502 saying it is "at capacity" means nothing was written, so run it again a
little later, or for fewer countries at a time (a run replaces only the
countries it names).

To name places and routes yourself:

```bash
pnpm run activity places                       # list places, unnamed ones first
pnpm run activity routes                       # list same routes
pnpm run activity name-place <id> "Moj hrib"
pnpm run activity name-route <id> "Tivoli loop"
pnpm run activity merge-place <id> <into-id>   # one summit found as two places
pnpm run activity unmerge-place <id>
```

A name of `""` clears it. Names and merges are kept in `group_overrides` and
apply on the same run. One that points at a place or route that is gone (its
first activity was hidden, say) is reported after every refresh, with the
command that clears it. `places` and `routes` only read: with R2 they read a
fresh copy of the database in R2, and they never upload, refresh or change the
local copy.

## Rebuild

```bash
pnpm run rebuild
```

Rebuilds the database from the archive. Activities keep their IDs, manual
pins, deletions and hidden flags, and your place and route names and merges
(`group_overrides`) carry over; the OSM snapshots in the archive are applied
again and places and routes refresh as after any write job. Everything else is
re-derived, so rebuilding twice gives the same rows. If an activity in the database has no record in the
archive (a wrong `--archive` path, say), it stops without changing anything;
`--force` rebuilds anyway and those activities lose their data.

## Display files

`pnpm run build:tracks` reads the database and writes the files the site
loads to `app/public/data/`. The folder is emptied first, so a hidden or
deleted activity never leaves a stale file behind.

| File | Contents |
| --- | --- |
| `routes.json` | One simplified polyline per activity with a route. |
| `activities.json` | Every visible activity's numbers. |
| `activity/<id>.json` | One activity's samples, fetched only when it is opened. |
| `profiles.json` | Elevation profiles, fetched only by the Analytics page. |
| `places.json` | Places reached (name, height, peak or pass) and named same-route groups. No coordinates. Empty without the group tables. |
| `steps.json` | Daily step totals, fetched only by the Analytics page. The newest day (still being counted when it was fetched) is left out. Empty without step data. |

An unknown value is left out, never written as `0`. Daily step totals are the
only wellness data published; `build:tracks` reads nothing else from
`daily_stats`. The browser never calls the Strava or Garmin APIs.

`build:tracks` reads the database at `DB_PATH` when set (the deploy sets it),
else `data/activities.sqlite`, else the demo database
`data/demo/activities.sqlite`.

Design notes: [`2026-11-04-display-files-design.md`](2026-11-04-display-files-design.md).
