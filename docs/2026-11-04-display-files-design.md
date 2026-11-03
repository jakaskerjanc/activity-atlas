# Design: Display files and activity charts (v2 data model, Plan 4)

Date: 2026-11-04
Status: decided by the builder on the owner's brief (no approval round)
Issues: [#23](https://github.com/jakaskerjanc/strava-on-maps/issues/23) §4/§5
groundwork, [#17](https://github.com/jakaskerjanc/strava-on-maps/issues/17)
Spec: `docs/2026-10-27-data-model-storage-design.md`, sections "Display files
(deploy build step)" and "Readers"

## Intent

The owner clicks an activity on the map, say a hike. Today the bottom panel
shows four numbers. It does not show the shape of the day: where the big climb
was, how hard their heart was working, where they slowed down.

Plans 1–3 put lossless per-second streams in the database. The site still
reads a stop-gap `tracks.json` (Plan 3's "display bridge"): simplified routes
and three numbers per activity, with unknown values written as `0`.

Plan 4 replaces the bridge with the spec's display files and uses them:

- an elevation profile for the selected activity, with heart rate and pace
  (or speed) charted underneath on the same axis;
- hovering a chart moves a marker along the route, and the panel reads out
  distance, time, altitude, HR and pace at that point (#17);
- an unknown value shows as "—", and totals say how many activities they
  cover instead of counting the rest as zero.

## Goals

- Three display files, built at deploy from the database, as the spec lists:
  routes, per-activity numbers, and per-activity detail files.
- Detail files of about 5–15 KB gzipped, fetched only when an activity is
  opened.
- A Node decoder for the stream codec, tested against blobs the Python code
  encoded.
- Charts for the selected activity: elevation, HR, pace or speed. Each one
  appears only when its channel exists.
- Two-way hover sync between the charts and the map route.
- Honest numbers everywhere the app shows one: cards, totals and the color
  ramps.

## Non-goals

- The analytics page (§5). The numbers file is shaped for it, but no page is
  built.
- Comparing activities (#16, #18, #19, #20).
- A map redesign, URL state or deep links (§4).
- The demo database (§6), Garmin gear, parallel R2 uploads.
- Changing ingest. The database is read as it is; any clean-up of provider
  values happens in the display build.
- Wellness on the site.
- Activities without a route on the map. They have no line to click (see
  [Decisions](#decisions-made-for-the-owner)).

## Anti-goals: failure even if it works

- A hidden or deleted activity reaches any display file, including a stale
  detail file left over from an earlier build.
- Wellness data reaches the site.
- An unknown value shows as `0`, or a total silently skips activities without
  saying so.
- A chart draws a line across a gap in the recording as if it were data, or
  invents a value where the stream has none.
- Opening an activity downloads more than one small file, or the first page
  load grows by the detail data.
- A new runtime dependency for charts.

## Constraints

- **Read-only on R2.** The build reads `data/activities.sqlite`, which
  `ingest.sync` or the deploy's read-only pull wrote. Nothing in Plan 4
  writes to R2 or triggers a workflow.
- **Same pipeline shape:** `pnpm run build` runs `build:tracks`, then the app
  build. The deploy workflow does not change.
- **The stream codec is fixed** (`ingest/codec.py`, encoding version 1):
  per-channel scale, delta from the last present value, `MISSING = -2**63`,
  int64 little-endian, zlib. The Node decoder must match it exactly.
- **Static site.** No server; all files are fetched from Pages.
- **App stack:** React 19, Mapbox GL, Vite, Vitest, inline styles, no chart
  library.
- **Public data:** heart rate becomes public (the spec's accepted note).
  Positions in detail files are no more precise than the routes already are.

## Verified facts (2026-11-04, synced database)

**Activities:** 530, all visible. 447 have a route.

**Channel coverage** (activity flags and the `streams` table agree):

| Channel | Activities |
|---|---|
| time | 530 |
| distance (stream) | 528, but indoor ones are all zeros |
| GPS (lat/lon) | 447 |
| HR | 502 |
| altitude | 437 |
| cadence | 358 |
| speed (stream) | 432 |
| power | 153 |
| temperature | 257 |

- Every visible activity has a `streams` row. No routed activity lacks one.
- 32 GPS activities have no speed stream (20 hikes, 6 walks, 4 rides, 2 runs).
  All 32 have a distance stream.
- No stream has a missing time sample.

**Samples per activity:** median 2,747, max 44,479, total 1.99 M. The median
sampling interval is 1 s. Some files use smart recording (1–5 s).

**Provider zeros that mean "unknown"** (the database keeps what the provider
reported):

| Value | Count | All of them… |
|---|---|---|
| `distance = 0` | 66 | have no GPS (gym, workouts, indoor rides) |
| `elevation_gain = 0` | 92 | 90 have no altitude channel, 10 of those have a route |
| `avg_hr = 0` | 17 | have no HR channel (routed hikes, rides, walks) |
| `avg_hr IS NULL` | 11 | have no HR channel |
| `hr_zone_seconds IS NULL` | 28 | have no HR channel or no zones |

**Detail-file sizes** (one JSON file per activity, every chart channel,
gzip -9, all 530 activities):

| Downsampling | Encoding | Median | p90 | Max | Total |
|---|---|---|---|---|---|
| 1 s | plain | 27.2 KB | 66.8 KB | 274.5 KB | 18.3 MB |
| 5 s | plain | 9.2 KB | 31.6 KB | 86.2 KB | 7.3 MB |
| 5 s | delta | 3.3 KB | 12.2 KB | 34.3 KB | 2.8 MB |
| 10 s | plain | 5.2 KB | 18.3 KB | 56.7 KB | 4.3 MB |
| 5 s, ≤1000 points | plain | 8.9 KB | 12.8 KB | 15.2 KB | 4.5 MB |
| 5 s, ≤1000 points | delta | 3.2 KB | 6.1 KB | 7.9 KB | 1.9 MB |
| 5 s, ≤1500 points | plain | 9.2 KB | 17.5 KB | 21.9 KB | 5.3 MB |

Plain 5 s files blow the target only on long activities: a 9 h hike has
6,700 points. Capping the point count fixes the tail without changing the
median.

## Architecture

```
data/activities.sqlite ──▶ scripts/build-tracks.ts ──▶ app/public/data/
                             ├─ codec.ts    (stream decoder)    ├─ routes.json
                             ├─ numbers.ts  (rows → records)    ├─ activities.json
                             └─ detail.ts   (streams → samples) └─ activity/<id>.json
```

- `build:tracks` keeps its name, so `pnpm run build` and the deploy workflow
  are unchanged.
- The output folder `app/public/data/` is **deleted and rewritten on every
  build**. A detail file for an activity that has since been hidden or deleted
  therefore cannot survive (anti-goal 1). The folder is gitignored.
- The old `app/public/tracks.json` is no longer written. The build deletes a
  stale local copy so Vite cannot bundle it.

## File formats

All three are JSON. Every file has its own wire version `v`; the app refuses
a version it does not know, as it does today. Absent means unknown: a key is
left out, never written as `0` or `null`, except inside sample arrays (below).

### `data/routes.json`, v4

```json
{"v": 4, "routes": {"k3j9x0a1bc": "_p~iF~ps|U_ulLnnqC…"}}
```

- Keyed by activity ID. One Google polyline (precision 5) per visible
  activity with a route, simplified with Douglas–Peucker at 10 m, exactly as
  today's `tracks.json`.
- `v: 4` continues the `tracks.json` lineage (v3 was the bridge).

### `data/activities.json`, v1

```json
{"v": 1, "activities": [
  {"id": "k3j9x0a1bc", "name": "Morning Hike", "type": "Hike",
   "ts": 1723975135, "start_date": "2024-08-18T09:58:55+00:00",
   "start_local": "2024-08-18T11:58:55",
   "distance": 14210.4, "moving_time": 16020, "elapsed_time": 19811,
   "elevation_gain": 1204, "elevation_loss": 1198,
   "avg_hr": 131, "max_hr": 172, "hr_zones": [2072, 5217, 1773, 0, 0, 0],
   "channels": ["gps", "hr", "altitude", "cadence"],
   "sources": [{"provider": "strava", "id": "111"}, {"provider": "garmin", "id": "222"}],
   "detail": true}
]}
```

- Every visible activity, with or without a route, sorted by start time then
  ID. This is the file §5's analytics page will read.
- `ts` (epoch seconds UTC) and `start_date` (ISO UTC) keep their current
  names, so the map filter and the replay don't change. `start_local` is the
  local wall-clock time.
- `hr_zones`: seconds below zone 1, then in zones 1–5, as stored.
- `channels`: which stream channels the activity has, from the `has_*` flags.
- `sources`: live provider records only, Strava first (unchanged from v3).
- `detail: true` when `activity/<id>.json` exists, so the app never requests a
  file that isn't there.

**Unknown values.** The display build drops a number when it is NULL, and
also in these cases where the provider wrote `0` for "not measured":

| Field | Dropped when |
|---|---|
| `distance` | `≤ 0` |
| `moving_time`, `elapsed_time` | `≤ 0` |
| `elevation_gain`, `elevation_loss` | `0` and the activity has no altitude channel |
| `avg_hr`, `max_hr` | `≤ 0` |
| `hr_zones` | the activity has no HR channel, or every zone is 0 |

A flat run with an altimeter keeps its real `elevation_gain: 0`.

### `data/activity/<id>.json`, v1

```json
{"v": 1, "step": 5,
 "t":     [2, 7, 12, …],
 "d":     [4, 18, 31, …],
 "lat":   [46.05123, 46.05131, …],
 "lon":   [14.50581, 14.50602, …],
 "alt":   [312.4, 312.9, …],
 "hr":    [97, 101, null, …],
 "speed": [1.21, 1.34, …],
 "cad":   [52, 54, …]}
```

- One file per visible activity whose streams have at least one channel worth
  charting (all 530 today). Route-less activities get one too, for §5.
- **Downsampling:** samples fall into buckets of `step` seconds by their time.
  Each output point is the mean of the bucket's present values, per channel; a
  channel with no present value in a bucket is `null` there. Empty buckets (a
  paused watch) produce no point.
- **`step`** is 5 s, raised for long activities so a file never exceeds 1000
  points: `step = max(5, ceil(duration_s / 1000))`. A 9 h hike gets 33 s.
- **Channels and units:**

  | Key | Unit | Rounding | Source channel |
  |---|---|---|---|
  | `t` | s since start | integer | time |
  | `d` | m from start | integer | distance |
  | `lat`, `lon` | degrees | 5 decimals (~1 m) | lat, lon |
  | `alt` | m | 1 decimal | altitude |
  | `hr` | bpm | integer | hr |
  | `speed` | m/s | 2 decimals | speed, else derived from `d` |
  | `cad` | rpm / spm as stored | integer | cadence |

- All arrays have the same length as `t`. `t` never holds `null`.
- A channel is left out when it has no present value. `d` and `speed` are
  also left out when they never exceed 0 (indoor sessions whose distance
  stream is all zeros).
- **Speed fallback:** when the stream has no speed channel but `d` exists,
  `speed[i] = (d[i] - d[i-1]) / (t[i] - t[i-1])` on the downsampled points
  (first point copies the second). That covers the 32 GPS activities without
  a speed stream.
- Power and temperature are not shipped: the spec's channel list leaves them
  out and the panel does not use them.
- Plain arrays, no delta encoding: the capped files already fit the target
  (median 8.9 KB, max 15.2 KB gzipped), and the app needs no decoder.

## App behaviour

### Loading

- On start the app fetches `routes.json` and `activities.json` in parallel and
  joins them by ID. The map shows the activities that have a route (447 today),
  as it does now. Activities without a route are in the file but not on the
  map.
- Selecting an activity with `detail: true` fetches its detail file once and
  keeps it in memory for the session.

### The info panel for a selected activity

Top to bottom:

1. Title, subtitle and source links, as today.
2. Stat cards. With charts below them, the four cards sit in one compact row;
   without charts they keep today's 2×2 grid.
3. A readout row (only with charts): values at the hover point, e.g.
   `8.42 km · 2:14:05 · 1,204 m · 152 bpm · 21:30 /km`. Only channels the
   activity has appear. With no hover point the row shows a muted hint,
   "Hover the chart or the route".
4. The charts, stacked, sharing one x axis:

   | Chart | Shown when | Notes |
   |---|---|---|
   | Elevation | `alt` exists | filled area, y labels in m |
   | Heart rate | `hr` exists | line, bpm |
   | Pace | `speed` exists and the type is foot-based (Run, Walk, Hike…) | min/km, faster at the top |
   | Speed | `speed` exists, any other type | km/h |

   Cadence is not charted; it appears in the readout when present. Power is
   neither charted nor shipped.

- **X axis:** distance in km when `d` exists, otherwise elapsed time. There is
  no toggle.
- **Gaps:** a `null` sample breaks the line; nothing is interpolated.
- **Pace/speed smoothing:** the app plots a centred 5-point moving mean of
  `speed` (about 25 s at the 5 s step), used for the readout too. Pace below
  0.3 m/s (standing) is a gap, and the pace axis spans the 5th–95th
  percentile so one stop doesn't flatten the chart.
- **Hover:** pointer (mouse, pen or touch) over any chart sets one shared
  **cursor**: an index into the detail arrays. A vertical line crosses all
  charts at that point, and the readout fills in.
- **Leaving** the chart clears the cursor, as do a new selection, deselecting,
  and starting replay.
- **States without charts:**
  - no detail file: "No samples recorded for this activity.";
  - loading: "Loading samples…";
  - fetch failed: "Couldn't load samples.";
  - a detail file with no chartable channel: the same text as no file.
- **Aggregate view** (nothing selected): unchanged, except the honest totals
  below.

### Map sync (#17)

- **Chart → map:** while the cursor is set, a ringed dot sits on the route at
  the cursor's `lat`/`lon`. No dot when that sample has no position.
- **Map → chart:** while an activity is selected and its detail is loaded,
  moving the pointer over that activity's route sets the cursor to the nearest
  sample. Leaving the route clears it.
- Replay keeps owning the bottom slot. No charts, cursor or dot during replay.

### Honest numbers

- **Cards:** an unknown value shows "—". Pace and speed need both distance
  and moving time.
- **Totals:** distance, elevation and moving time sum the activities that have
  the value. When some don't, the card says so, e.g. `Elevation m` with a note
  `437 of 447`. When none do, the value is "—".
- **Color ramps:** the elevation and speed modes compute their domain from the
  activities that have the value. An activity without it draws in a neutral
  grey instead of the ramp's low end.

### Narrow screens

- The panel keeps its current rules: collapsed by default under 1000 px, at
  most `100vw - 84px` wide.
- Charts measure their container and redraw at its width.
- The panel's height is capped at `100vh - 140px`; past that it scrolls, so a
  phone in landscape can still reach every chart.
- Chart heights: elevation 84 px, the others 52 px each, so three charts and
  the readout fit in about 250 px.

## Decisions made for the owner

1. **Two files for routes and numbers** (`routes.json` + `activities.json`):
   §5 needs numbers for all 530 activities but no routes; the map loads both
   in parallel.
2. **The map shows only activities with a route**, as today: a route-less
   activity has no line to click, and putting it in the map's filter and
   totals would change the map's meaning, which is §4/§5's call.
3. **Detail step 5 s, capped at 1000 points:** keeps every file inside the
   5–15 KB target (max 15.2 KB measured) while short activities keep full 5 s
   detail.
4. **Plain JSON arrays, no delta encoding:** the cap already meets the target,
   and plain arrays need no decoder in the app or in §5.
5. **Bucket means, not decimation:** averaging smooths 1 s GPS speed and HR
   noise, and a paused stretch simply has no points.
6. **Charts: elevation, HR, then pace (foot types) or speed (others):** the
   owner's three questions are the climb, the effort and the slow-downs.
7. **Cadence in the readout only, power not shipped:** neither answers the
   owner's question, and power is mostly the watch's running power estimate
   (129 of 153 are runs).
8. **No-stream activities show their cards plus one muted line:** an empty
   chart frame would look broken.
9. **Distance axis, no toggle:** distance lines up with the route on the map,
   and the time axis is only the fallback when there is no distance.
10. **Two-way sync, as #17 asks:** the map side is one nearest-sample search
    over at most 1000 points.
11. **Charts stack under the cards, no tabs:** the owner wants the shape on
    click, not behind an extra tab. #17's `Details | Elevation` pills are
    dropped.
12. **Hand-rolled SVG, no library:** four simple line/area charts at 1000
    points; a library would add weight without solving anything hard.
13. **Provider zeros dropped in the display build:** the database keeps what
    providers reported, and ingest stays untouched (no rebuild against R2).
    The rules are listed per field above.
14. **Totals say their coverage** ("437 of 447"): the spec names "total
    elevation quietly skipping activities" as an anti-goal.
15. **Neutral grey for routes without the colored value:** painting them at
    the ramp's low end would claim a value.
16. **Each file has its own version** (routes v4, activities v1, detail v1):
    they change independently.
17. **The build empties `app/public/data/` first:** the only way to be sure a
    hidden activity's old detail file is gone.
18. **Keep the `build:tracks` script name:** the deploy workflow and the
    owner's habits call it; renaming buys nothing.

## Testing

- **Codec:** Python writes `scripts/fixtures/codec.json` (blobs for every
  channel, including missing samples, negative deltas, an antimeridian jump
  and an empty stream). A pytest test fails if the committed fixture drifts
  from the Python encoder. A Node test decodes every blob and compares with
  the values.
- **Numbers:** the zero/NULL rules per field; hidden and deleted activities
  absent; sources Strava first; route-less activities present in
  `activities.json`, absent from `routes.json`.
- **Detail:** bucket means, nulls, the 1000-point cap, channel omission, the
  speed fallback, rounding, `detail` flag agreement with the files written,
  and a stale file in the output folder removed by a rebuild.
- **App:** the join, version checks, "—" and coverage notes, neutral color
  expressions, chart geometry (ticks, paths with gaps, pace inversion,
  nearest-sample lookup), panel states, and the marker/nearest-sample logic.
- **Real data:** `pnpm run build:tracks` against the synced database, then
  report file sizes (routes, numbers, detail count, median and max gzipped).
