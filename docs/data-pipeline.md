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
the export's all-day monitoring data as wellness data, which is never
published.

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

## Rebuild

```bash
pnpm run rebuild
```

Rebuilds the database from the archive. Activities keep their IDs, manual
pins, deletions and hidden flags; everything else is re-derived, so rebuilding
twice gives the same rows. If an activity in the database has no record in the
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

An unknown value is left out, never written as `0`. No wellness data is
published, and the browser never calls the Strava or Garmin APIs.

`build:tracks` reads the database at `DB_PATH` when set (the deploy sets it),
else `data/activities.sqlite`, else the demo database
`data/demo/activities.sqlite`.

Design notes: [`2026-11-04-display-files-design.md`](2026-11-04-display-files-design.md).
