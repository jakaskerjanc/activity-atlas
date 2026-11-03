# Design: Data model, dedupe, and storage (v2 §3)

Date: 2026-10-27
Status: draft (design), awaiting approval
Issue: [#23](https://github.com/jakaskerjanc/strava-on-maps/issues/23), workstream 3

## Intent

v1 stores one summary row per activity: name, type, time, distance, moving
time, elevation gain, a simplified route and a start point. The database is
committed to git and rebuilt into `app/public/tracks.json` at deploy time.

v2 needs much more than that, for two consumers:

- **The analytics page (§5)** needs heart rate and elevation, both per activity
  (an activity's HR / elevation curve) and in aggregate (HR trends, time in
  zones, elevation totals). The open elevation issues (#16–#20) need the same
  data.
- **An agent over the local MCP server (§7)** benefits from as much data as
  possible: full-resolution streams, laps, gear, and Garmin's per-day wellness
  data (resting HR, HRV, sleep, stress, steps, body battery, weight).

The owner's rule is **keep as much as possible**. Storage is cheap, and some
originals exist in only one place. The 138 pre-watch activities exist only in
the Strava export. Garmin's Personal API may serve only recent data. The
original export folders are no longer on the dev machine.

That much data cannot live in git. The database is committed by a daily
GitHub Action. Thirty versions are already in history, and the packed repo is
13 MB. Per-second streams would make the database tens of MB. So the complete
archive moves to a private Cloudflare R2 bucket. Git keeps only code. The
public site gets small, optimized display files built from the archive.

Activities still arrive from both Strava and Garmin. One real-world activity
stays one row, linked to every provider record it came from, and the UI links
to all of them. The activity's own identity must not depend on which provider
it came from.

## Goals

- Archive every original the pipeline sees, untouched: export zips, activity
  files (FIT/TCX/GPX), Garmin monitoring files, and every API response.
- A full-resolution SQLite database: activities, per-provider source records,
  per-second streams, laps, gear, daily wellness numbers and intraday wellness
  series.
- Lossless ingest. Every lossy step (simplification, downsampling) happens only
  when building display files.
- The database can be rebuilt from the archive at any time, giving the same
  result, with activity IDs unchanged.
- Provider-neutral, permanent activity IDs.
- Both Strava and Garmin IDs kept per activity, with a link to each on the
  activity detail.
- A matcher that survives edits (crop, rename, retype) and has documented,
  tested rules, plus manual merge/split fixes.
- Edits made in Garmin Connect after an activity was first fetched reach the
  database. They show on the site wherever Strava has no value of its own (see
  [Merge policy](#merge-policy)).
- Template forks deploy the demo data without R2.

## Non-goals

- Publishing wellness data on the site. It is stored but not published; the
  owner will decide later.
- Showing the data: the map (§4), analytics UI (§5), MCP server (§7), search
  and tags (§8). This design produces the data they consume, and leaves room
  for their tables.
- Strava live fetch. The adapter slot stays a stub.
- Cleaning git history and creating the demo dataset (§6). This design only
  requires that a demo database exists in the repo.
- Shipping SQLite to the browser (sqlite-wasm, HTTP range requests). Decided
  against: the browser gets precomputed display files.
- Backfilling Strava-only activities into Garmin Connect to have a single
  source. Considered and dropped by the owner.

## Anti-goals: failure even if it works

- Personal data (database, raw files, wellness) lands in git or on the public
  site by accident.
- Any data is lost before it reaches the archive.
- An activity's ID changes because of import order, a rebuild, or an edit in
  Garmin/Strava.
- An activity's ID or URL reveals which provider it came from.
- Missing data is silently counted as zero. For example, averaging HR over
  activities that have no HR, or "total elevation" quietly skipping activities
  without altitude.
- A template fork cannot deploy without a Cloudflare account.

## Decisions made with the owner

1. **Keep everything**, including raw FIT files, export zips, API responses,
   Garmin monitoring files and per-day stats.
2. **The archive lives in a private Cloudflare R2 bucket.** The database
   leaves git.
3. **Wellness is stored in R2, not published.**
4. **The analytics page needs HR and elevation**, so display files carry
   per-activity HR/elevation numbers and per-activity downsampled curves.
5. **Activity ID = a random, provider-neutral code, assigned once and never
   changed.** No `g:`/`s:` prefixes. The owner rejected prefixed IDs and found
   a separate ID-mapping file too complicated. In this design the database
   itself remembers IDs (see [Identity and rebuilds](#identity-and-rebuilds)).
6. **Dedupe stays.** Each activity keeps its Garmin and Strava IDs and links to
   both.
7. **Optimization is split.** Ingest is lossless. Only the display-file build
   loses detail.
8. **R2 is the only way to publish your own data.** No mode commits the
   database to git. A fork without R2 deploys the demo data only. This
   replaces §6's "personal forks can opt in to committing their DB".
9. **Strava wins on merged activities** whenever Strava and Garmin differ,
   because Strava is where the owner edits (see [Merge policy](#merge-policy)).

## Verified facts (2026-10-27)

**Current database** (`data/activities.sqlite`, 1.6 MB):

- 527 activities: 352 with both IDs, 138 Strava-only, 37 Garmin-only.
- Range: 2023-10-23 → 2026-10-27.
- 843 recorded hours, 778 of them with GPS.
- 81 activities have no GPS: gym, workouts, treadmill, indoor rides.
- No two activities share a start minute. The closest two starts are 19
  minutes apart.

**Current code**, mismatches to fix along the way:

- `dedupe.reconcile` matches the opposite provider within **±180 s**, with
  **no distance check**. The README claims ±90 s and ±5% distance.
- `build-tracks.ts` simplifies routes to **10 m**. The README says 5 m.
- The importer simplifies routes to 0.5 m **before storing**. The
  full-resolution track never reaches the database.
- The FIT parser keeps only lat/lon. It drops timestamps, HR, altitude and
  every other channel.
- The live fetch only asks for activities newer than `MAX(start_time)`. It
  never re-reads older activities, so edits made in Garmin Connect are lost.
- The app builds its only source link from the ID prefix
  (`app/src/format.ts:86`). Merged activities show only one link.
- The app has no deep link to a selected activity (no URL state), so changing
  IDs breaks no external links.

**Exports**, from `docs/2026-09-11-export-ingest-design.md`:

- **Strava:** 490 activities. Originals: 352 `.fit.gz`, 121 `.tcx.gz`,
  15 `.gpx`. `activities.csv` has 103 columns.
- **Garmin:** 7,721 FIT files in `UploadedFiles_*.zip`. About 353 are
  activities (`file_id.type == activity`); the rest are monitoring and other
  device files.

**Stream sizes**, measured on `ingest/tests/fixtures/outdoor.fit`: a 1 h run,
3,673 one-second records with lat/lon, altitude, HR, cadence, speed, distance
and temperature.

| Storage option | 1 h run | Owner's 843 h (estimate) | ~10 years (estimate) |
|---|---|---|---|
| Raw FIT | 227 KB (103 KB gzipped) | ~190 MB | ~600 MB |
| One SQLite row per sample | 190 KB | ~160 MB | ~530 MB |
| Per-channel delta + zlib blobs | 18 KB | ~15 MB | ~50 MB |
| Same, without lat/lon | 7.5 KB | ~6 MB | ~20 MB |
| Time + HR + altitude only | 2 KB | ~1.6 MB | ~5 MB |

All estimates are scaled from one file. Re-measure with the real exports (see
[Measurement](#measurement-and-verification)).

**Monitoring data**, from `ingest/tests/fixtures/monitoring.fit`
(Forerunner 265, `monitoring_b`, 11 KB):

- all-day HR (195 samples)
- stress (331 samples)
- respiration rate (331 samples)
- resting HR
- activity/intensity markers

**Garmin Personal API wellness endpoints**, from the
`garmin/connect-personal-api-python` README, not yet probed with the owner's
key:

- daily summaries: `/usersummary-service/v2/dailysummaries`
- sleep: `/sleep-service/sleep/dailySleepSummariesByDate`
- HRV: `/hrv-service/hrv/daily/{start}/{end}`
- body battery: `/wellness-service/wellness/bodyBattery/reports/daily`
- stress and steps: `/usersummary-service/stats/{stress,steps}/daily/...`
- daily heart rate: `/wellness-service/wellness/dailyHeartRate`
- weight: `/weight-service/weight/range/...`
- SpO2
- HR zones: `/biometric-service/heartRateZones/v2`

**Cloudflare R2**, from developers.cloudflare.com:

- Free tier: 10 GB-month of storage, 1 M Class A and 10 M Class B operations
  per month.
- Egress (downloads) is free. Storage beyond the free tier costs
  $0.015/GB-month.
- `PutObject` supports `If-Match` / `If-None-Match`, evaluated atomically with
  the write. A stale `If-Match` fails with `412 PreconditionFailed`.

## Architecture

```
Sources                Writers                      R2 (private)            Readers                Public
-------                -------                      ------------            -------                ------
Strava export zip ─┐
Garmin export zip ─┼─▶ import CLI (laptop) ─┐
                   │                        ├─▶ exports/  raw/  db/ ──┬─▶ deploy Action ──▶ GitHub Pages
Garmin Personal API ─▶ daily fetch (Action) ─┘                         └─▶ sync (laptop) ──▶ MCP server
Strava API (stub)
```

Only the two writers change the archive. Both follow the same cycle:

1. Pull the database and remember its R2 ETag.
2. Store originals in R2.
3. Parse them into the database.
4. Upload the database with `If-Match: <etag>`.
5. On `412`, discard local changes, pull again and redo the work. Ingest is
   idempotent and originals are content-addressed, so this is safe. Give up
   after 3 attempts.

### Where things live

| | Repo (public) | R2 (private) | Pages (public) | Laptop (gitignored) |
|---|---|---|---|---|
| Code, workflows, schema | ✓ | | | |
| Demo database (synthetic, §6) | ✓ | | | |
| Export zips, raw files | | ✓ | | cache `data/raw/` |
| Full database | | ✓ | | synced `data/activities.sqlite` |
| Wellness | | ✓ (in the database) | | synced copy |
| Display files | | | ✓ built by CI | local dev build |
| Secrets | | | | `.env` |

### R2 layout

```
exports/strava/<YYYY-MM-DD>-<original-name>.zip    export zips, byte-for-byte
exports/garmin/<YYYY-MM-DD>-<original-name>.zip
raw/<sha256>                                       every original file and API response
db/activities.sqlite                               the live database
db/snapshots/<YYYY-MM-DD>.sqlite                   backups, written by each successful writer
```

- **Content-addressed `raw/`.** The same FIT arriving from both Strava and
  Garmin is stored once.
- **What each blob is** (provider, kind, which activity or date) is recorded in
  the `raw_files` table, not in the key.
- **Snapshot retention (my call):** keep the last 30 daily snapshots plus the
  first snapshot of each month, forever.

### Storage backends

Ingest, sync and deploy talk to an archive interface with two backends:

- **R2**, the owner's setup.
- **Local folder** (`data/archive/`, gitignored), the default for template
  forks and tests.

Configuration goes through `.env` / Actions secrets. The client library is the
builder's choice. `ingest/garmin_api.py` is deliberately stdlib-only, and
GitHub runners ship the AWS CLI, which works against R2's S3 endpoint.

### Writers

**Import CLI** (`import:strava`, `import:garmin`), run on the laptop:

1. Takes the export **zip** and uploads it unchanged to `exports/`.
   - It also accepts an unzipped folder for development, with a warning that
     no export archive is stored.
2. Stores every member file the pipeline reads in `raw/`:
   - activity files
   - `activities.csv`
   - `*summarizedActivities.json`
   - monitoring FITs
   - per-day wellness JSON found in the export
3. Parses activities, streams, laps, gear and wellness into the database.

**Daily fetch** (GitHub Action, cron):

1. Lists activities newer than the high-water mark **and re-checks every
   activity that started in the last 30 days**.
   - A listed activity counts as changed when its summary DTO differs from the
     stored one.
   - For a changed activity, it re-downloads the file. A new file hash means
     a new version.
2. Stores every API response (list pages, activity ZIPs) in `raw/`.
3. Fetches wellness endpoints for every day since the last stored day, plus
   the last 7 days again, because Garmin revises sleep and HRV after late
   syncs. It stores the responses in `raw/` and parses them.
4. Uploads the database (`If-Match`) and writes the snapshot.
5. Calls the deploy workflow via `workflow_call`.

This removes the git commit, the `contents: write` permission and the `GH_PAT`
secret.

### Readers

**Deploy** (GitHub Action), triggered by the fetch, by pushes to `main` that
touch code, or by hand:

1. Pulls the database with a **read-only** R2 token.
2. Builds the display files.
3. Builds the app and publishes it to Pages.

Without R2 secrets, it builds from the demo database in the repo.

**Sync** (laptop): `sync` pulls the database to `data/activities.sqlite`. A
helper fetches `raw/<sha256>` blobs into `data/raw/` on demand, for the MCP
server and for rebuilds.

## Data model

Data passes through four layers. Each layer can be recomputed from the ones
above it:

| Layer | Where | What |
|---|---|---|
| Raw | R2 `exports/`, `raw/` | Original files and API responses, untouched |
| Parsed | Database | Values read straight from raw data: streams, laps, gear, each provider's reported numbers, Garmin's daily stats |
| Computed | Database | Values we calculate: time in zones, gap-filling numbers, routes, bounding boxes, coverage flags, merge winners |
| Display | Pages | Simplified and downsampled for the browser |

The database is one SQLite file. The master copy is `db/activities.sqlite` in
R2. The Actions runners and the laptop work on temporary copies. Everything in
it is **derived** (recomputable from the archive) except the identity columns
of `activity_sources` and the `activity_overrides` table. Column lists name the required content. Exact
names and types are the builder's.

### `activities`: one row per real-world activity

- **`id`:** 10 random characters from `[a-z0-9]`, assigned when the activity
  is first created, unique, never changed.
- **Display values**, chosen by the [merge policy](#merge-policy):
  - name, type
  - `start_time` (UTC), `utc_offset` / local start time
  - elapsed time, moving time, distance
  - elevation gain and loss
  - calories when a source provides them
- **Summary numbers** (average/max HR, average cadence/power, elevation
  gain/loss, calories). Each one is filled at ingest in this order (decided by
  the owner):
  1. The provider's own reported value, chosen by the
     [merge policy](#merge-policy): Strava's, otherwise Garmin's. The site
     then matches what the owner sees in those apps and respects edits such as
     Strava's "correct elevation".
  2. Otherwise, calculated from the chosen streams.
  3. Otherwise NULL, never 0.
- **Time in HR zones** follows the same order. Garmin FIT files report it in a
  `time_in_zone` message, together with the zone limits used that day (verified
  on `outdoor.fit`). Store both. For activities without it (TCX/GPX,
  pre-watch), calculate it from the HR stream using the zone limits from the
  closest Garmin FIT in time.
- **Always calculated:** the route line, coverage flags, merge winners, and
  the bounding box for TCX/GPX (FIT sessions report one). Also local start time
  for Strava-only activities, from the start coordinates, and per-sample speed
  where the file has only positions.
- **Never calculated:** calories and training effect/load. They stay NULL when
  no provider reports them.
- The database records which values were calculated rather than reported; the
  format is the builder's call.
- **Route:** route polyline (0.5 m simplified, derived from the chosen
  streams), start lat/lng, and bounding box (for §8 geo queries).
- **Channel flags:** which stream channels exist, e.g. `has_gps`, `has_hr`,
  `has_altitude`, so analytics can report coverage ("HR for 412 of 527").
- **Winners:** which source supplied the display values and which supplied the
  streams.

**HR zones (my call):** zone limits come from the FIT files' `time_in_zone`
messages, which record the limits in effect for each activity. No zones API
call is needed.

### `activity_sources`: one row per provider record

**Identity**, kept across rebuilds:

- `provider`
- `provider_activity_id`
- `activity_id`
- `pinned` (set by manual fixes)
- `deleted_at` (see [Deletions and hiding](#deletions-and-hiding))
- Primary key: (`provider`, `provider_activity_id`)

**Derived:**

- link URL:
  - Strava: `https://www.strava.com/activities/{id}`
  - Garmin: `https://connect.garmin.com/modern/activity/{id}`
- this source's own start, elapsed, distance, type and name, so both providers'
  raw values are kept
- the provider's summary record verbatim as JSON (CSV row, summarized-activity
  entry or API DTO), queryable with `json_extract`
- the `sha256` of its activity file
- first-seen and last-updated times

### `activity_overrides`: kept across rebuilds

One row per activity with a manual override. Today the only override is
`hidden` (see [Deletions and hiding](#deletions-and-hiding)). Together with the
identity columns of `activity_sources`, this is the only state a rebuild
cannot recompute.

### `streams`: one row per activity

- **Provenance:** which source record the streams came from, plus sample count
  and an encoding version.
- **One BLOB per channel**, NULL when absent: time, lat, lon, altitude, HR,
  cadence, speed, distance, power, temperature.
  - The builder may add channels the parsers can read (respiration, running
    dynamics). Anything not extracted is still in the raw file.

**Encoding** (must decode identically in Python for MCP and in Node for the
build):

- Each value is quantized to an int32 at a resolution at least as fine as the
  source's:
  - time: seconds from start
  - lat/lon: degrees × 1e7
  - altitude: m × 10
  - HR: bpm
  - cadence: rpm
  - speed: mm/s
  - distance: cm
  - power: W
  - temperature: °C
- Missing samples use the sentinel `INT32_MIN`.
- Values are delta-encoded, written little-endian, and compressed with zlib.
- Lossless relative to the source. The builder documents the format next to
  the code and covers it with a cross-language round-trip test.

### `laps`

One row per lap, from FIT lap messages and TCX laps:

- activity id, lap index
- start, elapsed and moving time
- distance
- average and max HR
- average speed
- elevation gain and loss
- average cadence and power
- lap trigger

Exact fields are the builder's call.

### `gear` and `activity_gear`

- Gear items (provider, provider gear id, name, kind) and their links to
  activities.
- Sources: the Strava export (gear column and gear CSVs) and Garmin export or
  API gear data. **Availability is unverified.** Store whatever the exports and
  API actually provide.

### `daily_stats`: one row per local calendar date

- **Columns for the most-used values:**
  - resting HR
  - HRV (nightly average, status)
  - sleep duration and score
  - steps
  - average stress
  - body battery high/low
  - weight
  - SpO2
- **Each source endpoint's raw JSON** for that day, for everything else.

### `daily_series`: one row per (date, channel)

- Intraday series: all-day HR, stress, respiration, body battery, sleep stages.
- Same blob encoding as `streams`.
- Sources: monitoring FITs (export) and the wellness endpoints (API).

### `raw_files`

- `sha256` (primary key), size, content type
- `kind`: export zip, activity file, monitoring FIT, API response,
  export member
- provider, provider reference (activity id, date, endpoint), original name,
  fetched time

Rebuilds read this table to find their inputs.

### Schema versioning

- `PRAGMA user_version` holds the schema version.
- When the code's version is newer than the database's, the writer runs a
  rebuild instead of hand-written migrations. The builder may still use
  `ALTER TABLE` for trivial additive changes.

## Identity and rebuilds

- **Rebuild:**
  - Takes the current `activity_sources` identity rows (provider,
    provider_activity_id, activity_id, pinned, deleted_at), the
    `activity_overrides` rows, and the archive.
  - Re-parses every raw file into a fresh database.
  - Re-applies the identity and override rows.
  - Provider records without an identity row go through the matcher as new
    records.
- **Deterministic:** the same archive plus the same identity rows produce the
  same database, timestamps aside.
- **If the database is ever lost,** restore the identity and override rows from
  the latest snapshot.
- **Why IDs can be random:** the database remembers them, and a rebuild never
  invents a new ID for a provider record it has seen before. The ID carries no
  meaning, so a crop, rename or retype in Garmin/Strava never changes it.

## Dedupe and matching

Runs at ingest for every incoming provider record:

1. **Known record:** (`provider`, `provider_activity_id`) already exists. Update
   that activity in place. Edits arrive this way.
2. **Overlap match:** among activities with no record from this provider yet,
   find those whose time range overlaps the incoming record's range (start →
   start + elapsed).
   - Accept the best overlap if it covers ≥ 50% of the shorter range (my call)
     and no guard fails.
   - Overlap replaces v1's ±180 s start window. A cropped activity is a
     sub-range of the uncropped one, so crops still match.
3. **Fallback:** if either side has no elapsed time (manual entries), use v1's
   ±180 s start-time window.
4. **Same-provider records never merge.** Two Garmin records are always two
   activities, as in v1.
5. **No match:** create a new activity with a new random ID.

**Guards (my call):**

- Reject a match when both sides have GPS distance and the distances differ by
  more than 20%.
- A type mismatch alone does not block a match, because owners re-type
  activities. It is logged.
- The builder tunes thresholds against the real exports and documents the
  final rules in the code and README. The README's current claim is wrong.

**Pinned records** (manual fixes) are never moved by the matcher.

**Deleted records** (`deleted_at` set) are ignored by the matcher. A deleted
Strava record therefore no longer occupies its activity's Strava slot, so a
re-upload with a new Strava ID merges into the same activity instead of
becoming a duplicate.

**Manual fixes:** a CLI pulls the database, edits identity rows, sets `pinned`,
and uploads with `If-Match`:

- `activity merge <id> <id>`
- `activity split <id> <provider>:<provider_activity_id>`

### Deletions and hiding

All of this section is my call.

- **When a source record counts as deleted:**
  - the daily fetch's 30-day re-check no longer lists it, or
  - a newer export from the same provider lacks it, and it falls within that
    export's date range.
  - The record gets `deleted_at`. Nothing is removed from the database or the
    archive, which keeps the "keep everything" rule.
- **What deletion does:**
  - Deleted records do not count as winners in the merge policy.
  - An activity whose source records are all deleted is kept, with all its
    data, but left out of the display files.
- **Manual hiding:** `activity hide <id>` / `activity unhide <id>` set
  `activity_overrides.hidden`. A hidden activity stays in the database and in
  the MCP data but is left out of the display files.
- **Provider privacy settings** (e.g. Garmin's per-activity privacy) are
  ignored. The site shows every activity that isn't deleted or hidden, as v1
  does.

### Merge policy

Decided by the owner: Strava is where activities get edited, so **Strava wins
whenever the two differ**.

- **Every display value** (name, type, summary stats, streams and route) comes
  from the Strava record when Strava has that value. Otherwise it comes from
  Garmin. For example, a Strava manual entry with no file still gets Garmin's
  streams if Garmin has them.
- **Deleted records** never win (see [Deletions and hiding](#deletions-and-hiding)).
- **Both sources' raw values** stay in `activity_sources`, so a Garmin-side
  edit is stored even when it isn't shown.
- **Strava edits show up only after the next Strava export import,** because
  there is no Strava live fetch.

## Display files (deploy build step): the only lossy step

Built by an extended `scripts/build-tracks.ts`:

- **Routes:** as today (10 m Douglas–Peucker, Google polyline), keyed by the
  new ID. Wire version bumps.
- **Per-activity numbers:** one file for the map and analytics. It has every
  value in `activities` that the UI filters or charts:
  - type, start (UTC and local)
  - distance, moving time, elevation gain/loss
  - average/max HR, time in zones
  - channel flags
  - source links (one per `activity_sources` row)
  - Whether this merges with the routes file is §4/§5's call.
- **Per-activity detail files** (`activity/<id>.json`), loaded when an
  activity is opened:
  - channels: time, distance, lat/lon, altitude, HR, pace/speed, cadence
  - downsampled to ~5 s (tunable)
  - target size: about 5–15 KB gzipped each
  - serves #17 (elevation profile synced with the map) and §5's activity
    charts
- **No wellness.**

Note: per-activity HR becomes public on Pages, the same way routes are public
today. The owner asked for HR on the analytics page.

## CI changes

**Fetch workflow:**

- Secrets: `GARMIN_PERSONAL_API_KEY` plus a read-write R2 token
  (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`).
- No git push, no `contents: write`, no `GH_PAT`.
- Keeps its `concurrency` group.

**Deploy workflow:**

- A read-only R2 token (separate secret pair).
- Path filter: drop `data/activities.sqlite`, keep code paths.
- `workflow_call` trigger for the fetch.
- Demo fallback when the R2 secrets are absent.

`scripts/ci_fetch.sh` loses its commit/push step.

## Migration from v1 (one time)

1. Create the R2 bucket and two tokens (read-write, read-only).
2. Request fresh Strava and Garmin exports. The old ones are not on the dev
   machine.
3. Import both into a fresh database through the new pipeline. This archives
   exports and raw files, and every activity gets a random ID.
4. Run the first fetch to backfill API-only wellness and confirm the
   incremental path.
5. Sanity-check against the v1 database: activity counts per provider, and
   merged pairs. v1 has 352 merged pairs. Explain every difference (new
   matcher, edits).
6. Switch both workflows. `git rm data/activities.sqlite` and add `data/` to
   `.gitignore` (except the demo database's location). History cleanup is
   §6's job.

No ID aliasing is needed: v1 IDs are not referenced by any URL.

## Measurement and verification

Before tuning anything, run these against the real exports and the owner's API
key:

- **Sizes:** database, archive (exports + raw), and display files.
  - Compare with the estimates above.
  - The archive should stay within the R2 free tier.
- **Channel coverage:** how many activities have GPS, HR, altitude, cadence and
  power. The 138 pre-watch Strava activities are the unknown.
- **Start-time agreement:** do Strava and Garmin start times agree on merged
  activities? This is expected, because Strava stores Garmin's FIT.
- **Crop behaviour:** crop a test activity in Garmin Connect. Does
  `download-service/files/activity/{id}` return the cropped or the original
  file? Does the list DTO change?
- **Export wellness files:** which per-day files the Garmin export contains, and
  their date range.
- **API wellness:** each wellness endpoint with the real key, and how far back
  it serves data.

## Testing

- **Matcher:**
  - overlap merge
  - crop on one provider
  - same-provider near records stay distinct
  - the distance guard
  - the no-elapsed fallback
  - pinned records survive re-import
  - manual merge/split
  - a deleted record is ignored, and a re-upload with a new ID merges into the
    same activity
- **Merge policy:**
  - Strava wins every value it has, including streams and route
  - Garmin fills only the gaps
  - a Garmin rename on a merged activity is stored but not shown
  - a provider-reported summary number beats our calculation from streams;
    the calculation fills only missing values
- **Deletion and hiding:**
  - deleted and hidden activities stay in the database but are left out of
    the display files
  - `deleted_at` and `hidden` survive a rebuild
- **Stream encoding:** Python encode → Node decode round-trip is lossless,
  including missing samples.
- **Rebuild:** deterministic, and keeps every ID.
- **Writers:**
  - an `If-Match` conflict re-pulls and retries
  - identical files are stored once
  - re-running an import changes nothing
- **Edits:** a changed DTO within 30 days updates the activity in place, and its
  ID is unchanged. An activity missing from the re-check gets `deleted_at`.
- **Template:** deploy with no R2 secrets builds from the demo database.
- **Display files:** NULL stays absent (never 0), and totals reconcile with the
  database.
- **Existing tests:** the bulk-import and fetch tests stay green, updated for
  the new IDs.

## Left to the builder

- Client library for R2.
- Exact table and column names.
- Lap and gear fields.
- Extra stream channels beyond the required list.
- Matcher thresholds, within the rules above.
- Display-file formats and whether routes and numbers share one file.
- Downsample interval for detail files.
- CLI command names.
- Snapshot retention details.
