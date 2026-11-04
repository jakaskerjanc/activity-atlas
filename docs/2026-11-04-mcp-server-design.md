# Design: MCP server over the activity database

Date: 2026-11-04
Status: draft for the owner's review
Depends on: the `fix/api-intraday-series` PR (API heart rate and HRV readings
into `daily_series`), being built in parallel. This branch rebases on it.

## Intent

The owner wants to ask an LLM questions about their own training and health
in plain language and trust the answer. The first real example: "is my
average running pace improving year over year?" Answering that from
`data/activities.sqlite` took one SQL query, but several silent choices
decided whether the answer was right: moving or elapsed time, total time over
total distance or the mean of per-run paces, whether a 300 m warm-up counts,
calendar year or season. An LLM with bare SQL access makes those choices
quietly and sounds just as sure either way.

So the server's job is less "give the model access" and more "give the model
the right definitions": a guide to what the data means, a few tools that apply
the agreed definitions, raw read-only SQL for everything else, and decoders for
the parts SQL cannot read (the per-activity sample blobs and the all-day
wellness series).

A second real example sets the location scope: "hikes to Triglav". A name
search finds "Triglav Sunrise" but also "Triglav Lake(s)", which never came
within 5 km of the summit, and misses "Gorje Hiking" (2026-09-20), which
passed 14 m from it. Location questions are answered from the GPS tracks, not
from names.

## Who and where

<!-- Owner decisions in the brainstorm (2026-11-04): Claude Code first, one
local database synced from R2, location options 1+2 now and 3 later, the
intraday HR/HRV fix as its own PR first, the five anti-goals below. -->


- One user, the owner, asking mainly from **Claude Code** on this machine.
- A local stdio MCP server that the agent starts itself. No hosting, no
  login, no open ports. Because it is plain MCP over stdio, any MCP-capable
  agent on this machine (Codex, OpenCode, Cursor…) can use it with the same
  command; only Claude Code's setup is documented and tested.
- Claude Desktop is out: it is not installed here and has no official Linux
  build. A client on another computer would need hosting, which is a
  non-goal.
- No separate agent skill. The instructions an LLM needs (the data guide and
  the definitions) live inside the server, as the `guide` tool and the
  server's `instructions`, so every agent gets the same rules. A thin Claude
  Code skill can be added later if the owner finds themselves repeating
  prompts.
- Python, because the stream codec (`ingest/codec.py`), the R2 store and the
  sync code (`ingest/writer.py`, `ingest/objstore.py`) already exist there.

## Goals

- Answers to period and trend questions (pace, distance, time, elevation,
  heart rate, by week, month or year and activity type) computed by the server
  with fixed, documented definitions.
- Every tool result says **what was counted** (rules applied, how many
  activities were included and how many were left out and why) and **how
  current the data is**.
- Wellness in scope alongside activities, so questions like "does bad sleep
  slow my runs?" can join the two.
- Per-activity samples (HR, pace, altitude, cadence, power along the route)
  and the all-day wellness series, decoded and downsampled.
- Location search: turn a place name into coordinates, then find the
  activities whose route came near it.
- Read-only raw SQL for questions the tools do not cover.
- The data the server reads is kept current from R2 automatically.

## Non-goals

- Writing anything: no merge, split, hide, edits or imports through the LLM.
  The server only reads (sync replaces the local copy from R2, nothing more).
- A phone or web client, remote hosting, auth.
- Charts or a UI. The clients draw their own.
- Starting a Garmin fetch. A run finished an hour ago may not be in R2 until
  the daily CI fetch (~04:17 UTC); the server says how current it is instead.
- Tagging activities with the named places they pass (peaks, huts, lakes from
  an offline OpenStreetMap extract, "option 3"). Planned for later; see
  [Room for place tags](#room-for-place-tags-later).
- intervals.icu, the Strava API, or anything else online besides R2 and the
  place lookup.

## Anti-goals: failure even if it works

1. **Confident wrong answers.** A tool silently applies a definition the owner
   would not have chosen, or the model reaches for raw SQL where a tool with
   the right definition exists, and nothing in the answer shows it.
2. **Silently stale data.** A question about yesterday is answered from last
   week's copy with no hint.
3. **Bloated answers.** A tool dumps 40,000 GPS points or a day's raw JSON
   into the conversation.
4. **Fiddly to keep running.** It breaks when the database changes shape,
   needs manual restarts, or needs tokens copied around by hand.
5. **Data leaving the machine** beyond the conversation with Claude and the
   place names sent to the geocoder.

## Data: one source of truth

The master database is `db/activities.sqlite` in the R2 bucket
`strava-maps`. Every writer, local or in CI, pulls it, changes a temporary
copy and uploads with `If-Match`. `data/activities.sqlite` in the main
checkout is a local copy, replaced by `npm run sync` and at the end of every
local writer run, and never uploaded.

The owner wants one local copy, not a second one for the server. So:

- The server reads and syncs **`data/activities.sqlite` of the main
  checkout**, given as an absolute path in the client config (worktrees have
  no `data/`).
- **Sync** uses the **read-only** R2 token (`R2_RO_ACCESS_KEY_ID`,
  `R2_RO_SECRET_ACCESS_KEY`, with `R2_ACCOUNT_ID` and `R2_BUCKET`) from the
  main checkout's `.env`. It reuses `writer.pull` and `writer.install`, which
  download to a temporary file and rename it over the copy in one step, so no
  reader ever sees a half-written file. After a sync the server reopens its
  connection.
- **When:** on server start, and before a tool call when the last check is
  more than an hour old (builder may tune). A `sync` tool forces one.
- **Cheap check first:** compare the R2 object's etag (from `head`) with the
  local file. The writer uploads with a single `put_object`, so the etag
  should be the MD5 of the content; if that holds, hash the local file and
  skip the 44 MB download when they match. If it does not hold, keep the last
  seen etag next to the file. Builder verifies which.
- **Without R2** configured, or when the check or download fails, the server
  answers from the local file as it is, never overwrites it, and reports the
  failure in the freshness block.

## What every result carries

Every tool result has two blocks besides its data:

- **`as_of`**: newest activity start, newest wellness day, when the last sync
  check ran and its outcome (`up to date`, `downloaded`, `failed: <reason>`,
  `no R2`).
- **`counted`** (for anything aggregated or filtered): the filters and rules
  applied, the number of activities or days included, and the number left out
  with the reason for each (e.g. "3 runs without moving time", "HR known on 61
  of 69").

## Definitions the tools apply

These are the agreed defaults. They go into the guide tool verbatim, so the
model and the owner read the same rules.

- **Which activities:** `visible = 1`, the same set the site shows. Hidden ones
  only when a tool's `include_hidden` is set.
- **Dates and periods:** the activity's **local** start date (`start_local`),
  not UTC. A run at 00:30 local on 1 January counts in the new year. Weeks
  start on Monday. The site and Analytics page use UTC; on 2026-11-04 none of
  the 530 visible activities falls on a different day (so also month or year)
  in local time than in UTC, so answers and the Analytics page agree today. A
  future late-night activity at a month boundary could differ; the guide
  states the rule.
- **Types:** the `type` column as stored (Run, Hike, Walk, Ride, …). No
  silent grouping: "running" means `Run` unless the caller lists more types.
- **Pace and speed over a set:** total moving time ÷ total distance, over the
  activities that have both. Never the mean of per-activity paces. Elapsed
  time is available as a separate metric, clearly named.
- **Average heart rate over a set:** each activity's `avg_hr` weighted by its
  moving time, over the activities that have HR.
- **Totals:** sums of known values. An unknown value is left out and counted
  in `counted`, never treated as 0.
- **No hidden thresholds.** A minimum distance or duration is a parameter the
  caller sets, and is listed in `counted` when used.

## Tools

Names and parameter shapes are the builder's call; this is the set and what
each must do.

| Tool | Does |
|---|---|
| `guide` | Returns the data guide: tables and columns with units and meaning, which values can be missing, the definitions above, coverage dates, and when to prefer which tool. Also sent as the server's `instructions`. |
| `sync` | Forces a sync check and download now; returns `as_of`. |
| `list_activities` | Filtered list (types, local date range, name contains, distance/duration range, has HR/GPS), sortable, paged, compact rows with id, local date, type, name, distance, moving time, pace or speed, elevation gain, avg HR. |
| `get_activity` | One activity in full: numbers, HR zones, laps, gear, source links (Strava/Garmin URLs). |
| `summarize` | Totals and averages per period (week, month, year, or all) and per type, using the definitions above. Metrics include count, distance, moving and elapsed time, pace or speed, elevation gain, avg HR. |
| `activity_samples` | One activity's samples, decoded from `streams`, for chosen channels (time, distance, lat/lon, altitude, hr, speed, cadence, power, temperature), averaged into buckets so the result stays under a point cap (default about 500). |
| `wellness` | `daily_stats` columns (resting HR, HRV, sleep, sleep score, steps, stress, body battery, weight, SpO2) per day or aggregated by week, month or year, with how many days had a value. |
| `wellness_series` | One day's all-day series from `daily_series` (hr, stress, respiration, and the new hrv channel), decoded and downsampled. |
| `find_place` | Place name → candidates from OpenStreetMap (name, kind, elevation if known, lat/lon, country). Several candidates are returned when the name is ambiguous. |
| `activities_near` | Activities whose route comes within a radius of a point, nearest first, with the closest distance and when along the activity it happened (elapsed time and local clock time). Takes the same filters as `list_activities`, and a mode: anywhere on the route, the start, or the end. |
| `query` | Read-only SQL with a row cap. For anything the tools do not cover. |

The guide tells the model to prefer `summarize` and the other tools for
anything they cover, and to say so when it falls back to `query`.

### Location search

- **Geocoding:** OpenStreetMap's Nominatim. Only the search text leaves the
  machine. Results are cached on disk (under `data/`, gitignored) so a name is
  looked up once. Follow Nominatim's usage policy: at most one request a
  second and an identifying User-Agent naming the app (not the owner's email).
- **The model may pass coordinates it already knows** to `activities_near`,
  but the guide tells it to confirm names through `find_place` first.
- **Matching:** a cheap pass on the stored bounding box (`min_lat`…`max_lng`,
  widened by the radius), then the exact closest approach against the
  full-resolution track decoded from `streams` (lat/lon). Fall back to the
  stored `polyline` only when an activity has no lat/lon stream.
- **Default radius:** 200 m (my call). It counts "Gorje Hiking" (14 m) as a
  summit visit and the Kranjska Gora hike (1.3 km) as not.

### Room for place tags later

Keep "closest approach of a track to a point" a small, separate function that
takes decoded coordinates and returns distance and sample index. A later job
can run it for every activity against a list of OpenStreetMap peaks, huts and
lakes and store the hits in a table the server searches ("which peaks have I
climbed this year?"). Nothing for that is built now.

## Safety and size

- **Read-only, enforced in SQLite, not by convention:** open the file with
  `mode=ro`, set `PRAGMA query_only`, and install an authorizer that denies
  anything but reads (no `ATTACH`, no writes, no pragmas that change state).
  Queries get a time limit (progress handler) and a row cap.
- **Raw payload columns are not readable through `query`** by default:
  `daily_stats.raw`, `activity_sources.summary_json` and
  `activity_sources.reported`. They are large (anti-goal 3) and can hold
  private notes (anti-goal 5). The authorizer returns them as NULL and the
  guide says why. (My call.)
- **Size caps** on every tool: rows (default 200 for lists, paged), points for
  samples and series, and a note in the result when something was cut.
- The `raw_files` table holds file names only and is fine to read.

## Wellness coverage

- `daily_stats` covers 2025-04-19 to today.
- `daily_series` (all-day HR, stress, respiration) currently ends 2026-09-05,
  the date of the Garmin export. The parallel PR unpacks the API's all-day
  heart rate and overnight HRV readings into `daily_series`, so after it
  merges and the owner rebuilds R2, HR and HRV run to today. Stress and
  respiration through the day stay export-only (the API has only daily stress
  totals and no respiration). The guide states these coverage limits.

## Setup the owner does once

- Python dependency: the official MCP Python SDK (`mcp`), pinned in
  `requirements.txt`.
- A run command (e.g. `python -m ingest.mcp_server`; avoid naming the package
  `mcp`, which shadows the SDK) taking the database path and the `.env` path.
- The README gets a section with the exact command to register it in Claude
  Code (`claude mcp add --scope user …`), plus the bare stdio command and
  arguments any other MCP client needs. Absolute paths to the owner's
  checkout live in that user-level config, not in a committed file (the repo
  is public).
- The server finds its `.env` and database from those arguments, never from
  the working directory, since agents start servers from wherever they run.

## Tests

- A small fixture database built in the tests (activities with and without HR,
  GPS and moving time; a hidden one; one across local midnight on 1 January; a
  track passing a known point; daily stats and a series row).
- Definitions: pace over a set is total time ÷ total distance; unknowns are
  excluded and counted; local-date bucketing; types not grouped silently.
- `query` refuses writes, `ATTACH` and state-changing pragmas, caps rows and
  NULLs the raw columns.
- Location: closest approach on a synthetic track; bounding-box widening
  doesn't drop a track that passes just outside its own box edge.
- Sync: up-to-date check skips the download; changed etag downloads and the
  server reopens; failure falls back to the local file and reports it; no R2
  never overwrites. Uses the in-memory `ObjectStore` that already exists.
- Geocoding is mocked; no network in tests.

## Left to the builder

- Exact tool names, parameter names and result field names.
- The SDK API used (the `mcp` package's current server API).
- How the guide text is stored (a markdown file in the package is fine).
- Bucket size and point caps, the sync interval, the cache file format.
- Whether `list_activities` and `activities_near` share one filter model
  (they should behave the same).

## Calls I made for the owner (check these)

- Local dates, not UTC, for periods; weeks start Monday.
- Raw JSON columns blocked in `query`.
- Default radius 200 m for "near".
- Sync check at most once an hour plus on start.
- No hidden minimum distance; thresholds are explicit parameters.
