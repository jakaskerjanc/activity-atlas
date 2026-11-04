# v2 Data Plan 4: Display files and activity charts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The deploy build turns the v2 database into three display files
(routes, per-activity numbers, per-activity detail samples). The app reads
them, shows unknown values as "—", and charts the selected activity's
elevation, heart rate and pace, with hover synced to a marker on the map.

**Architecture:**
- **Build** (`scripts/`): `build-tracks.ts` orchestrates three focused
  modules. `codec.ts` decodes the database's stream blobs. `numbers.ts` turns
  an `activities` row into a display record and drops unknown values.
  `detail.ts` downsamples decoded streams into a detail file. The build
  empties `app/public/data/` and writes `routes.json`, `activities.json` and
  `activity/<id>.json`.
- **App** (`app/src/`): `tracks.ts` joins routes and numbers into the map's
  FeatureCollection. `detail.ts` loads and caches detail files. `profile.ts`
  is a pure chart model (series, domains, ticks, paths, nearest sample). A
  hand-rolled SVG component draws it in the info panel. `App` owns one shared
  **cursor** (an index into the detail arrays) that the charts and the map
  both read and set.

**Tech Stack:** Node 22 + TypeScript + `tsx --test` + `better-sqlite3` +
`node:zlib` for the build; React 19 + Mapbox GL + Vitest for the app; Python
3 + pytest only to write the codec fixture. No new dependencies.

**Spec:** `docs/2026-11-04-display-files-design.md` (the Plan 4 design), which
refines "Display files (deploy build step)" and "Readers" in
`docs/2026-10-27-data-model-storage-design.md`. Plans 1–3 are merged on
`main`. This plan replaces Plan 3's Task 5 "display bridge".

This is plan 4 of 4.

## Global Constraints

- **Branch:** `plan-4-display-files`, from `main` at `a262564`. Do not push.
- **Never write to R2.** Only `python -m ingest.sync` (read-only) touches R2.
  Don't trigger workflows.
- **Output folder:** `app/public/data/`, gitignored, deleted and rewritten by
  every `pnpm run build:tracks`.
- **Wire versions:** `routes.json` `v: 4`, `activities.json` `v: 1`,
  `activity/<id>.json` `v: 1`. The app throws on any other version.
- **Absent means unknown:** a record key is omitted, never `0` or `null`.
  Only sample arrays in detail files hold `null`.
- **Zero rules** (design, "Unknown values"): drop `distance ≤ 0`;
  `moving_time`, `elapsed_time ≤ 0`; `elevation_gain`/`elevation_loss` equal
  to `0` without an altitude channel; `avg_hr`, `max_hr ≤ 0`; `hr_zones`
  without an HR channel or when every zone is `0`.
- **Detail files:** `DETAIL_STEP_S = 5`, `DETAIL_MAX_POINTS = 1000`,
  `step = max(5, ceil((duration_s + 1) / 1000))` (changed in Task 4: without the
  `+ 1`, a 5000 s activity gets 1001 points). Keys `t d lat lon alt hr speed cad`.
  Rounding: `t`, `d`, `hr`, `cad` integers; `lat`/`lon` 5 decimals; `alt`
  1 decimal; `speed` 2 decimals. No power, no temperature, no wellness.
- **Charts:** elevation (`alt`), heart rate (`hr`), then pace for foot types
  (`isFootBased`) or speed for the rest (`speed`). Distance x axis when `d`
  exists, else time. No toggle. Cadence only in the readout.
- **Pace:** centred 5-point moving mean of `speed`; speed `< 0.3` m/s is a
  gap; y domain is the 5th–95th percentile of pace; faster at the top.
- **Chart heights:** elevation 84 px, HR and pace/speed 52 px. Panel
  `maxHeight: "calc(100vh - 140px)"`.
- **Neutral route color** for a missing ramp value: `NEUTRAL = "#7a7f8c"`.
- **Panel copy:** `"No samples recorded for this activity."`,
  `"Loading samples…"`, `"Couldn't load samples."`,
  `"Hover the chart or the route"`.
- **Checks after every task** (all must pass):
  - `.venv/bin/python -m pytest ingest -q`
  - `pnpm run test`
  - `pnpm --filter app run test`
  - `pnpm run typecheck`
  - and, for tasks that touch `app/`, `pnpm --filter app exec tsc --noEmit`
    (Vitest does not type-check, and `pnpm run typecheck` covers only
    `scripts/`).

## Review Focus

1. **An activity hidden after an earlier build** → its old
   `activity/<id>.json` and its route are gone after the next build, because
   the build empties the folder (Task 2, Task 4).
2. **A 12 h activity with 44k samples** → its detail file has at most 1000
   points and stays near 15 KB gzipped (Task 4).
3. **A hike with long stops** (speed ≈ 0) → the pace chart shows a gap, not a
   spike to infinity, and its axis isn't flattened by the stop (Task 5).
4. **The detail fetch fails** (404 after a redeploy, offline) → the panel
   says "Couldn't load samples." and the cards still show (Task 5, Task 6).
5. **The cursor lands on a sample without a position** (GPS dropout) → the
   readout still updates and the map shows no marker instead of one at
   `[0, 0]` (Task 7).

---

### Task 1: Stream decoder for Node, with a Python-written fixture

**Files:**
- Create: `ingest/tests/codec_fixture.py`, `ingest/tests/test_codec_fixture.py`, `scripts/fixtures/codec.json` (generated), `scripts/codec.ts`, `scripts/codec.test.ts`

**Interfaces:**
- Produces:
  - `codec_fixture.CASES: list[tuple[str, str, list[float | None]]]`: (name,
    channel, values).
  - `codec_fixture.build() -> dict`:
    `{"encoding": 1, "cases": [{"name", "channel", "values", "blob"}]}`, where
    `values` is `codec.decode(channel, blob)` (so floats compare exactly) and
    `blob` is base64.
  - `python -m ingest.tests.codec_fixture` writes `scripts/fixtures/codec.json`
    (indent 1, sorted keys, trailing newline).
  - `scripts/codec.ts`:
    - `type StreamChannel = "time" | "lat" | "lon" | "altitude" | "hr" | "cadence" | "speed" | "distance" | "power" | "temperature"`
    - `CHANNEL_SCALES: Record<StreamChannel, number>`: the same values as
      `ingest/codec.py`.
    - `ENCODING_VERSION = 1`
    - `decodeChannel(channel: StreamChannel, blob: Uint8Array): (number | null)[]`

- [ ] **Step 1: Write the failing tests.**
  - `CASES` covers:
    - every channel in `CHANNEL_SCALES`;
    - `hr` with `None` at the start, middle and end;
    - `altitude` going up and down (negative deltas), e.g. `[312.4, 310.1, None, 315.0]`;
    - `lon` crossing the antimeridian, `[179.9999999, -179.9999999]`;
    - an empty `time` stream.
  - `test_codec_fixture.py::test_committed_fixture_matches_encoder`: the
    parsed `scripts/fixtures/codec.json` equals `build()`. On failure, the
    message names the regenerate command.
  - `codec.test.ts`:
    - `decodes every python fixture`: for each case,
      `decodeChannel(c.channel, Buffer.from(c.blob, "base64"))` deep-equals
      `c.values`;
    - `fixture encoding matches ENCODING_VERSION`;
    - `rejects an unknown channel`: `decodeChannel("foo" as StreamChannel, …)`
      throws.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_codec_fixture.py -q; pnpm run test`.
  Expected: FAIL (no module, no `codec.ts`).

- [ ] **Step 3: Implement** `codec_fixture.py`. Generate the fixture with
  `.venv/bin/python -m ingest.tests.codec_fixture`. Then implement
  `decodeChannel`:
  - `inflateSync` from `node:zlib`;
  - read int64 LE with `DataView.getBigInt64(i * 8, true)`;
  - `MISSING = -(2n ** 63n)` → `null` and leaves `prev` unchanged;
  - otherwise `prev += delta` (BigInt), push `Number(prev) / scale`.

- [ ] **Step 4: Run all checks** (Global Constraints). Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: decode stream blobs in Node, checked against Python-encoded fixtures"`

---

### Task 2: Routes and numbers files

The build writes `app/public/data/routes.json` and
`app/public/data/activities.json`. It still writes `tracks.json` until Task 3
switches the app, so the site works at every commit.

**Files:**
- Create: `scripts/numbers.ts`, `scripts/numbers.test.ts`, `scripts/testDb.ts`
- Modify: `scripts/types.ts`, `scripts/build-tracks.ts`, `scripts/build-tracks.test.ts`

**Interfaces:**
- Produces (in `scripts/types.ts`):
  - `type Channel = "gps" | "hr" | "altitude" | "cadence" | "power"`
  - `interface ActivityRecord { id; name; type; ts; start_date; start_local?; distance?; moving_time?; elapsed_time?; elevation_gain?; elevation_loss?; avg_hr?; max_hr?; hr_zones?: number[]; channels: Channel[]; sources: ActivitySource[]; detail?: true }`
  - `interface RoutesFile { v: 4; routes: Record<string, string> }`
  - `interface ActivitiesFile { v: 1; activities: ActivityRecord[] }`
  - `interface DetailFile { v: 1; step: number; t: number[]; d?: (number | null)[]; lat?; lon?; alt?; hr?; speed?; cad? }`.
    Every optional array is `(number | null)[]`. Task 4 fills it.
- Produces (in `scripts/numbers.ts`):
  - `interface ActivityRow`: `id, name, type, start_time, start_local, distance, moving_time, elapsed_time, elevation_gain, elevation_loss, avg_hr, max_hr, hr_zone_seconds (JSON text | null), has_gps, has_hr, has_altitude, has_cadence, has_power, polyline, streams_sha256`.
    Numbers may be `null`.
  - `toRecord(row: ActivityRow, sources: ActivitySource[], hasDetail: boolean): ActivityRecord`
- Produces (in `scripts/build-tracks.ts`):
  - `ROUTES_VERSION = 4`, `ACTIVITIES_VERSION = 1`
  - `OUT_DIR = resolve(__dirname, "../app/public/data")`
  - `interface DisplayFiles { routes: RoutesFile; activities: ActivitiesFile; details: Map<string, DetailFile>; stats: { rawPoints: number; keptPoints: number } }`
  - `readDisplayFiles(dbPath: string, warn?: (m: string) => void): DisplayFiles`
  - `writeDisplayFiles(files: DisplayFiles, outDir: string): Promise<void>`:
    `rm -rf outDir`, then write `routes.json`, `activities.json` and
    `activity/<id>.json` for each detail.
- Produces (in `scripts/testDb.ts`):
  - `withDb(setup: (db) => void, run: (path: string) => void)`: creates the
    v2 tables the build reads (`activities` with the `ActivityRow` columns
    plus `visible`, `activity_sources`, and `streams` with
    `file_sha256, sample_count, encoding` plus one BLOB per `StreamChannel`).
  - `addActivity(db, id, over?)`
  - `addSource(db, activityId, provider, pid, deletedAt?)`

- [ ] **Step 1: Write the failing tests.**
  - `numbers.test.ts`, from a full row (all values present, all flags 1):
    - `keeps every present value under its record key`;
    - `drops null numbers`: `distance: null` → `!("distance" in rec)`;
    - `drops provider zeros`:
      - `distance: 0`, `moving_time: 0`, `elapsed_time: 0`, `avg_hr: 0` and
        `max_hr: 0` are each absent;
      - `elevation_gain: 0` with `has_altitude: 0` → absent;
      - `elevation_gain: 0` with `has_altitude: 1` → `0`.
    - `hr zones`:
      - `"[2072,5217,1773,0,0,0]"` → array;
      - absent when `has_hr: 0`;
      - absent when all zeros.
    - `channels follow the flags`: `has_gps:1, has_hr:1, others 0` →
      `["gps","hr"]`;
    - `ts and start_date`: `"2026-08-01T06:30:00+00:00"` →
      `ts 1785565800`, and `start_date` equals the input;
    - `detail flag`: `true` → `detail: true`; `false` → absent;
    - `never writes null`:
      `JSON.stringify(toRecord(allNullRow, [], false))` has no `null`.
  - `build-tracks.test.ts` (replace the bridge tests; use `testDb.ts`):
    - `routes keyed by id for visible routed activities`;
    - `route-less activity is in activities, not routes`;
    - `hidden activity is absent from both files` (`visible = 0`);
    - `sources list live providers strava first` (keep the Plan 3 assertion,
      deleted Garmin source dropped);
    - `activities sorted by start then id`;
    - `missing database yields empty files and a sync warning`:
      `{v:4, routes:{}}`, `{v:1, activities:[]}`, and a warning containing
      `sync`;
    - `writeDisplayFiles empties the output folder first`: a pre-existing
      `outDir/activity/stale.json` is gone after a write (Review Focus 1).

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm run test`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Query: `SELECT … FROM activities WHERE visible = 1 ORDER BY start_time, id`.
  - Routes: as today's `toTrack`. Decode, simplify at 10 m, re-encode, and
    skip lines under 2 points.
  - `main()` writes the display files. It still writes the v3 `tracks.json`
    bridge by mapping each routed record to an `EncodedTrack`: `?? 0` for the
    three numbers. Task 3 deletes this.
  - Log: `Wrote N routes, M activities, K detail files to app/public/data`.

- [ ] **Step 4: Run all checks.** Then run `pnpm run build:tracks` against
  the synced database. Expected: 447 routes, 530 activities.

- [ ] **Step 5: Commit.** `git commit -m "feat: build routes.json and activities.json with unknown values left out"`

---

### Task 3: App reads routes + numbers, honest numbers

**Files:**
- Modify: `app/src/types.ts`, `app/src/tracks.ts`, `app/src/App.tsx`, `app/src/stats.ts`, `app/src/format.ts`, `app/src/colors.ts`, `app/src/ui/StatsSection.tsx`, `app/src/testFixtures.ts`, `scripts/build-tracks.ts`, `scripts/types.ts`, `.gitignore`
- Test: `app/src/tracks.test.ts`, `app/src/stats.test.ts`, `app/src/format.test.ts`, `app/src/colors.test.ts`

**Interfaces:**
- Consumes: the wire types from Task 2, copied into `app/src/types.ts`.
  `ActivityFeatureProps = ActivityRecord`. `EncodedTrack` and `TrackPayload`
  are removed from both copies.
- Produces:
  - `tracks.ts`:
    - `ROUTES_VERSION = 4`, `ACTIVITIES_VERSION = 1`
    - `joinActivities(routes: RoutesFile, activities: ActivitiesFile): ActivityFeatureCollection`:
      activities with a route of at least 2 points, in `activities` order.
      Throws on a wrong version.
  - `format.ts`: `formatKm(m?: number, digits = 1)`,
    `formatDuration(s?: number)`, `formatMeters(m?: number)` (rounded, locale
    separators), `pacePerKm(m?: number, s?: number)`,
    `speedKmh(m?: number, s?: number)`. All return `"—"` when an input is
    missing.
  - `stats.ts`:
    - `interface Coverage { sum: number; n: number }`
    - `interface Totals { count: number; distance: Coverage; elevation: Coverage; moving: Coverage }`
    - `StatCard.note?: string`
    - `totalCards`: the value is `"—"` when `n = 0`; the note is
      `` `${n} of ${count}` `` when `0 < n < count`.
  - `colors.ts`: `NEUTRAL = "#7a7f8c"`. `computeDomain` skips missing values.
    The elevation mode is
    `["case", ["has","elevation_gain"], ramp, NEUTRAL]`. The speed mode is
    `["case", ["all", ["has","distance"], ["has","moving_time"]], ramp, NEUTRAL]`.
  - `App.tsx` fetches `` `${BASE_URL}data/routes.json` `` and
    `data/activities.json` with `Promise.all`.

- [ ] **Step 1: Write the failing tests.**
  - `tracks.test.ts`:
    - `joins routes onto records by id`;
    - `skips records without a route`;
    - `skips a route under 2 points`;
    - `throws on routes v3` and `throws on activities v2`;
    - `poly does not leak into properties`.
  - `stats.test.ts`:
    - `aggregate counts coverage per value`: three features, one without
      `elevation_gain` → `elevation {sum, n: 2}`;
    - `totalCards notes partial coverage`: the elevation card `note` is
      `"2 of 3"`;
    - `totalCards dashes a value nobody has`;
    - `activityCards dashes missing values`: no distance → distance `"—"` and
      pace `"—"`.
  - `format.test.ts`: `formatKm(undefined)`, `formatDuration(undefined)`,
    `formatMeters(undefined)`, `pacePerKm(1000, undefined)` and
    `speedKmh(undefined, 60)` are each `"—"`. `formatMeters(1204.4)` is
    `"1,204"`.
  - `colors.test.ts`:
    - `domain ignores activities without elevation`;
    - `elevation expression falls back to NEUTRAL when absent` (a `case`
      expression whose last element is `NEUTRAL`);
    - same for speed.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter app run test`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `StatsSection` renders `note` under the label, in muted mono at 9 px.
  - `build-tracks.ts`:
    - drop the `tracks.json` bridge and `buildTracks`/`EncodedTrack`;
    - `main()` deletes a stale `app/public/tracks.json` if one exists.
  - `.gitignore`: add `app/public/data/`. Keep the `tracks.json` line as a
    guard for stale copies.

- [ ] **Step 4: Run all checks**, including
  `pnpm --filter app exec tsc --noEmit`.

- [ ] **Step 5: Commit.** `git commit -m "feat: app reads routes and numbers files and shows unknown values as a dash"`

---

### Task 4: Detail files

**Files:**
- Create: `scripts/detail.ts`, `scripts/detail.test.ts`
- Modify: `scripts/build-tracks.ts`, `scripts/build-tracks.test.ts`

**Interfaces:**
- Consumes: `decodeChannel` (Task 1), `DetailFile`, `toRecord(…, hasDetail)`,
  `writeDisplayFiles` (Task 2).
- Produces (in `scripts/detail.ts`):
  - `DETAIL_VERSION = 1`, `DETAIL_STEP_S = 5`, `DETAIL_MAX_POINTS = 1000`
  - `interface Streams { time: (number | null)[]; distance?; lat?; lon?; altitude?; hr?; speed?; cadence? }`.
    Every optional field is `(number | null)[]`.
  - `detailStep(durationS: number): number`
  - `buildDetail(s: Streams): DetailFile | null`: `null` when none of `alt`,
    `hr` or `speed` (after the fallback) survives.

- [ ] **Step 1: Write the failing tests** (`detail.test.ts`):
  - `step is 5 s up to ~5000 s, then grows`: `detailStep(4995) = 5`,
    `detailStep(5000) = 6` and `detailStep(9000) = 10` (see the `+ 1` note in
    Global Constraints).
  - `bucket means per channel`:
    - time `0..9` at 1 s, hr `100..109` → `t [2, 7]`, `hr [102, 107]`;
    - `step` is `5`.
  - `missing samples are skipped, an all-missing bucket is null`.
  - `a pause makes no points`: times `0..4` and `100..104` → 2 points.
  - `never more than 1000 points`: 44,479 samples at 1 s →
    `t.length <= 1000` and the `step` from `detailStep` (Review Focus 2).
  - `rounding`:
    - `lat 46.0512345 → 46.05123`;
    - `alt 312.44 → 312.4`;
    - `speed 1.2345 → 1.23`;
    - `d 4.6 → 5`.
  - `omits absent and empty channels`:
    - no `cadence` → no `cad` key;
    - an all-`null` hr → no `hr` key;
    - a distance that is all `0` → no `d` and no `speed`.
  - `derives speed from distance when the stream has none`: `d [0, 10, 30]`
    at 5 s steps → `speed [2, 2, 4]`.
  - `null when nothing chartable`: only `time` and `cadence` → `null`.
  - `build-tracks.test.ts`:
    - `writes a detail file and sets detail for an activity with streams`
      (the streams row is encoded with Python-free test helpers:
      `encodeChannel` in `testDb.ts`, a straight port of `codec.encode`, used
      only by tests and checked against `scripts/fixtures/codec.json`);
    - `no detail for a hidden activity`;
    - `no detail flag without a streams row`.

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm run test`.

- [ ] **Step 3: Implement.**
  - **Bucket:** `floor((t - t0) / step)`; a point is `mean(present values)`
    per channel.
  - **Duration:** last time minus first time.
  - **Speed fallback:** runs on the bucketed, unrounded `d`.
  - **Build:**
    - one statement:
      `SELECT * FROM streams WHERE file_sha256 = ?`, per visible activity
      with `streams_sha256`;
    - decode only the channels `detail.ts` needs;
    - pass `hasDetail` to `toRecord`;
    - the log line reports the detail count.

- [ ] **Step 4: Run all checks.** Then run `pnpm run build:tracks` against
  the synced database. Expected: about 530 detail files.

- [ ] **Step 5: Commit.** `git commit -m "feat: per-activity detail files, 5 s means capped at 1000 points"`

---

### Task 5: Detail loading and the chart model (pure)

**Files:**
- Create: `app/src/detail.ts`, `app/src/detail.test.ts`, `app/src/profile.ts`, `app/src/profile.test.ts`, `app/src/ui/useActivityDetail.ts`
- Modify: `app/src/types.ts` (`DetailFile`), `app/src/format.ts` (`formatPace`, `formatClock`)

**Interfaces:**
- Produces:
  - `detail.ts`:
    - `DETAIL_VERSION = 1`
    - `parseDetail(json: unknown): DetailFile`: throws on a wrong `v`, or
      when an array's length differs from `t`.
    - `type DetailState = { status: "none" } | { status: "loading" } | { status: "error" } | { status: "ready"; detail: DetailFile }`
    - `loadDetail(id: string, fetchJson: (url: string) => Promise<unknown>): Promise<DetailFile>`:
      memoized per id. A rejected load is evicted, so a later open retries.
    - `detailUrl(id) = `${BASE_URL}data/activity/${id}.json``
  - `ui/useActivityDetail.ts`:
    `useActivityDetail(id: string | null, hasDetail: boolean): DetailState`.
    It keeps `{id, state}` and returns `"none"` for a stale id, so a slow
    response for a previous selection never shows.
  - `profile.ts`:
    - `type ChartKind = "elevation" | "hr" | "pace" | "speed"`
    - `interface ChartSeries { kind: ChartKind; values: (number | null)[]; domain: [number, number]; invert: boolean }`.
      Values are in display units: m, bpm, s/km, km/h.
    - `interface Profile { xKind: "distance" | "time"; x: number[]; charts: ChartSeries[] }`.
      `x` is m or s, non-decreasing.
    - `buildProfile(detail: DetailFile, type: string): Profile | null`
    - `smoothSpeed(v: (number | null)[], window = 5): (number | null)[]`:
      centred mean of the present values.
    - `niceTicks(lo: number, hi: number, count = 3): number[]`
    - `linePath(x: number[], y: (number | null)[], sx: (v: number) => number, sy: (v: number) => number): string`:
      a `null` starts a new `M` segment.
    - `areaPath(…same…, baseline: number): string`: one closed sub-path per
      segment.
    - `nearestIndex(x: number[], target: number): number`: binary search.
    - `readout(detail: DetailFile, profile: Profile, i: number, type: string): { label: string; value: string }[]`
  - `format.ts`: `formatPace(secPerKm: number): string` (`"5:06"`) and
    `formatClock(s: number): string` (`"2:14:05"`, `"14:05"`).

- [ ] **Step 1: Write the failing tests.**
  - `detail.test.ts`:
    - `parses a valid file`;
    - `rejects v2`;
    - `rejects a length mismatch`;
    - `loadDetail fetches once per id`: two calls → one fetch;
    - `a failed load is retried next time` (Review Focus 4).
  - `profile.test.ts`:
    - `charts follow the channels`:
      - `alt`, `hr` and `speed` on a Run → kinds `["elevation","hr","pace"]`;
      - a Ride → `["elevation","hr","speed"]`;
      - only `hr` → `["hr"]`;
      - none → `null`.
    - `x is distance when d exists, else time`: with `d` holding a `null`,
      `x` carries the previous value forward.
    - `pace is faster-up and gaps at stops`:
      - `invert: true`;
      - a speed of `0` → `null`;
      - the domain spans p5..p95 (a single 0.31 m/s outlier doesn't set the
        max) (Review Focus 3).
    - `speed is km/h from 0`: `domain[0] === 0`, `values[i] = speed * 3.6`.
    - `flat elevation gets a 20 m window`: `alt` all `300` → domain
      `[290, 310]`.
    - `smoothSpeed averages present neighbours`: `[1, null, 3]` with window 3
      → `[1, 2, 3]`.
    - `niceTicks(0, 1234, 3)` → `[0, 500, 1000]`.
    - `linePath breaks at null`: the path has two `M` commands for
      `[1, null, 2, 3]`.
    - `nearestIndex picks the closest x`.
    - `readout lists present channels in order`, distance first: on a Run
      → labels `["km","time","m","bpm","/km","spm"]`. A missing value at
      that index → `"—"`.

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm --filter app run test`.

- [ ] **Step 3: Implement** to the interfaces above. Cadence's readout label
  is `spm` for foot types and `rpm` for the rest.

- [ ] **Step 4: Run all checks**, including
  `pnpm --filter app exec tsc --noEmit`.

- [ ] **Step 5: Commit.** `git commit -m "feat: load detail files and model activity charts"`

---

### Task 6: Charts in the info panel

**Files:**
- Create: `app/src/ui/ActivityCharts.tsx`, `app/src/ui/ActivityCharts.test.ts`, `app/src/ui/useElementWidth.ts`
- Modify: `app/src/ui/InfoPanel.tsx`, `app/src/ui/StatsSection.tsx`, `app/src/App.tsx`, `app/src/ui/InfoPanel.test.ts`

**Interfaces:**
- Consumes: `Profile`, `buildProfile`, `readout`, `linePath`, `areaPath`,
  `niceTicks`, `nearestIndex` and `useActivityDetail` (Task 5).
- Produces:
  - `ActivityCharts` props:
    `{ detail: DetailFile; profile: Profile; type: string; cursor: number | null; onCursor: (i: number | null) => void }`.
  - `useElementWidth(fallback: number): [ref, width]`, using
    `ResizeObserver`. It returns `fallback` during server rendering.
  - `InfoPanel` new props:
    - `body?: ReactNode`: rendered under the cards;
    - `compactCards?: boolean`.
    The panel always passes `maxHeight="calc(100vh - 140px)"`.
  - `StatsSection` new prop `compact?: boolean`: four columns, value font
    16 px.
  - `App`: `const [cursor, setCursor] = useState<number | null>(null)`,
    reset on a new `selectedId` and on `startReplay`. The body is:
    - `ready` + a profile → `ActivityCharts`;
    - `loading` / `error` / `none`, or `ready` with a `null` profile → one
      muted line with the copy from Global Constraints.
    The aggregate view passes no body.

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`):
  - `renders one svg per chart`: a Run with `alt`, `hr` and `speed` → 3
    `<svg`.
  - `shows the hint without a cursor`: contains
    `"Hover the chart or the route"`.
  - `shows values at the cursor`: `cursor: 1` → contains the formatted HR at
    index 1 and `"/km"`.
  - `draws a cursor line only with a cursor`: `data-cursor` is present with
    `cursor: 1` and absent with `null`.
  - `InfoPanel.test.ts`: `renders the body under the cards` and
    `compact cards use four columns` (`repeat(4, 1fr)`).

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm --filter app run test`.

- [ ] **Step 3: Implement.**
  - **Layout:** one SVG per chart, full container width. Heights are 84
    (elevation) and 52 (the others).
  - **Labels:** y tick labels as SVG text, left-aligned inside the plot. The
    x axis labels (km or clock) sit under the last chart only.
  - **Pointer:** `onPointerMove`/`onPointerDown` on each SVG maps `offsetX`
    to the x domain, then calls `onCursor(nearestIndex(...))`.
    `onPointerLeave` calls `onCursor(null)`. Use `touch-action: pan-y`.
  - **Colors:** elevation fill `var(--accent)` at 0.18 opacity with an
    accent stroke; HR `#ff5d73`; pace/speed `#4cc9f0`; gridlines
    `var(--card-grid)`.
  - **Cursor:** a vertical line, plus a dot on each chart that has a value
    there.

- [ ] **Step 4: Run all checks**, including
  `pnpm --filter app exec tsc --noEmit`.

- [ ] **Step 5: Commit.** `git commit -m "feat: elevation, heart rate and pace charts for the selected activity"`

---

### Task 7: Map marker and route hover (#17)

**Files:**
- Create: `app/src/routeCursor.ts`, `app/src/routeCursor.test.ts`
- Modify: `app/src/MapView.tsx`, `app/src/App.tsx`

**Interfaces:**
- Consumes: `DetailFile`, the cursor in `App` (Task 6).
- Produces:
  - `routeCursor.ts`:
    - `cursorLngLat(detail: DetailFile, i: number | null): [number, number] | null`
    - `nearestSample(detail: DetailFile, lng: number, lat: number): number | null`:
      equirectangular distance with `cos(lat)`, skipping samples without a
      position. `null` without `lat`/`lon`.
  - `MapView` new props:
    - `cursorPoint: [number, number] | null`
    - `selectedDetail: DetailFile | null`
    - `onCursor: (i: number | null) => void`

- [ ] **Step 1: Write the failing tests** (`routeCursor.test.ts`):
  - `cursorLngLat returns [lon, lat]`;
  - `cursorLngLat is null at a sample without a position` (Review Focus 5);
  - `cursorLngLat is null without a cursor or GPS`;
  - `nearestSample finds the closest sample`;
  - `nearestSample skips null positions`;
  - `nearestSample is null without GPS`.

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm --filter app run test`.

- [ ] **Step 3: Implement.**
  - **Marker layers:** `installLayers` adds a GeoJSON source
    `activity-cursor` and two circle layers on top: a white ring of radius 7
    and an accent dot of radius 4.5. Rebuilding after a style swap re-adds
    them and restores the point.
  - **Marker updates:** an effect sets the source to the `cursorPoint`, or
    to an empty collection.
  - **Route hover:** the existing `mousemove` on `GLOW_ID`:
    - when the hit id is the selected id and `selectedDetail` is set →
      `onCursor(nearestSample(...))`;
    - otherwise, if the map set the cursor last → `onCursor(null)`.
    `mouseleave` clears the cursor the same way. A ref
    (`mapOwnsCursorRef`) tracks who set it, so map events never clear a
    chart-owned cursor.
  - **Replay:** the marker is hidden while replaying.

- [ ] **Step 4: Run all checks**, including
  `pnpm --filter app exec tsc --noEmit`.

- [ ] **Step 5: Commit.** `git commit -m "feat: sync the chart cursor with a marker on the route"`

---

### Task 8: Docs and the real-data run

**Files:**
- Modify: `README.md` (data flow, display files, `build:tracks`),
  `CONTEXT.md` (**Activity detail**, **Cursor**), this plan (measured sizes)

- [ ] **Step 1: Update the docs.**
  - The README's data-flow diagram and the `build-tracks.ts` paragraph name
    the three files and their versions.
  - `CONTEXT.md` gains:
    - **Activity detail:** the downsampled samples of one activity, loaded
      when it is selected.
    - **Cursor:** the point along the selected activity that the charts and
      the map marker share.

- [ ] **Step 2: Run against the synced database.**
  - `pnpm run build:tracks`
  - `pnpm --filter app run build`
  - Measure:
    - `routes.json` and `activities.json`, raw and gzipped;
    - the detail-file count;
    - the median and max gzipped detail size.
  - Record the numbers under "Measured" below.

- [ ] **Step 3: Run all checks.**

- [ ] **Step 4: Commit.** `git commit -m "docs: display files in the README and glossary, measured sizes"`

## Measured

Filled in by Task 8.

## Out of scope

- The analytics page (§5) and its shared filter bar.
- Comparing activities (#16, #18, #19, #20).
- A map redesign, URL state and deep links (§4).
- Route-less activities on the map or in the map's totals.
- Cadence and power charts; temperature and power in detail files.
- The demo database (§6), Garmin gear import, parallel R2 uploads.
- Any ingest change, rebuild or R2 write.
