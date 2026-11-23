# Running fitness on the Analytics page

A new Analytics card, **Running fitness**: one chart whose line goes up when the
owner gets fitter and down when they get less fit, over their runs.

Agreed with the owner on 2026-11-23 (brainstorm). Choices the owner did not make
are marked **(my call)**; the builder may revisit those with a reason.

## Why

The owner asked "am I getting fitter?" and wants "a chart that is going up or
down" to answer it. Pace alone can't answer it: most runs are hilly (Slovenia),
so a hilly run would look like a bad fitness day. The owner asked whether speed,
heart rate and grade could be combined into one number; they can.

## The number: efficiency, shown as flat-ground pace at 150 bpm

Per run, at build time, from the full-resolution streams in the database:

1. Each sample's speed is **grade-adjusted**: corrected for the grade at that
   moment with Minetti et al. (2002)'s energy cost of running,
   `C(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6` (J/kg/m, `i` = grade
   as a fraction). Adjusted speed = speed × C(i) / C(0). Climbing counts as
   faster running than it looks, steep descents as slower.
2. Grade is measured over a smoothed window of distance, not sample to sample
   (altitude noise would swamp it), and clamped to the model's range
   **(my call: ±0.30, window ~50 m; tune against real runs)**.
3. The first **10 minutes are skipped** (warm-up; heart rate lags). Pauses and
   samples where the owner is stopped or walking are left out **(my call: speed
   under ~1.5 m/s or a gap in the samples)**.
4. Efficiency = grade-adjusted metres ÷ heartbeats over the kept samples
   (metres per beat).
5. A run with too little kept data gets **no value**, never a guess **(my call:
   under 10 minutes kept)**.

Shown as **flat-ground pace at 150 bpm**: `1000 / (efficiency × 150/60)` seconds
per km, e.g. "5:40 /km". Faster = fitter. 150 bpm is a fixed reference for
readability only; the line's shape doesn't depend on it **(my call)**.

Type: `Run` only (the data has no TrailRun). Coverage on 2026-11-23: 158 of 159
runs have heart rate.

## The card

Sketch agreed with the owner:

```
 Running fitness                     flat-ground pace at 150 bpm
 5:20 /km ┤                                              ●  ●
          │                              ●   ● ●  ●──●──●─●
 5:50 /km ┤              ●  ●  ●──●──●──●─●
 6:20 /km ┤──●
          └──────────────────────────────────────────────────
 Faster than a year ago: 5:31 /km now, 5:58 /km in Nov 2025
```

- One dot per run with a value; a rolling line through them so one odd run
  doesn't swing it **(my call: a rolling median over a time window, e.g. 6
  weeks; pick what reads best on the real data)**. Faster is **up** on the axis.
- Follows the activity filter like every Analytics card: the visible
  activities, of type Run. When Run is switched off or no visible run has a
  value, the card says so instead of drawing an empty chart.
- The sentence under it compares the line now with the line a year earlier,
  and is left out when there is no line a year earlier **(my call)**.
- Hovering a dot names the run (name, date, value) **(my call)**; follow the
  existing cards' hover patterns.
- Listed in `ANALYTICS_SECTIONS` ("On this page").

## Data and pipeline

- `scripts/build-tracks.ts` computes the value from streams (it already decodes
  them per activity) and writes it as a new optional field on the run's
  `ActivityRecord` in `activities.json` (absent = unknown, never 0). Keep
  `scripts/types.ts` and `app/src/types.ts` in sync.
- The computation is a pure module with its own tests (hand-checked flat run,
  a climb-and-descend loop where grade adjustment must lift the value, warm-up
  and pauses excluded, too-short run → absent).
- Add the term to `CONTEXT.md`.

## Goals, non-goals

- Goal: an honest trend line; when it moves, it moves because of fitness, not
  because of routes.
- Non-goals: training load / fitness-fatigue curves, VO2max, the MCP server,
  other types than Run. Any of them can come later.
- Anti-goal: a number that tracks terrain or warm-up length instead of fitness.

## Approaches considered

1. **Per-sample grade-adjusted speed ÷ heart rate (picked by the owner).**
   Handles climbs and descents; uses the whole run. Costs a new build value.
2. Totals only: distance + 10 × climb, ÷ moving time, ÷ average HR. No build
   change, but crude (gentle and steep climbs count the same, descents ignored),
   noisy on exactly the hilly runs the owner does most. Rejected.
3. Pace in zone 2 on flat stretches only. Throws away most of a hilly run.
   Superseded by 1.
4. Garmin's VO2max estimate. Opaque, not verified to be in the export. Rejected.

## Left to the builder

Window sizes, thresholds and the rolling method above; chart details and
styling within the existing Analytics card conventions; where in the card
order it sits (suggest near Heart-rate zones).

## As built (2026-11-23, checked on the real runs)

- Kept from above: Minetti's curve, grade over 50 m clamped to ±0.30, 10-minute
  warm-up, under 10 minutes kept → no value, 150 bpm, pauses = sample gaps over
  60 s (zones.ts's limit). A 100 m window and a gentler descent clamp moved the
  hilly-run bias by only 2–5 s/km, not enough to depart from the curve.
- Changed: the 1.5 m/s "stopped or walking" cut is on **grade-adjusted** speed, so
  a steep climb taken at a walk still counts (hilly runs read 17 s/km slower than
  flat runs of the same weeks, against 20 s/km with the raw-speed cut).
- Added: heart rate is interpolated in time between its own samples; 27 of 159
  runs (Jul 2024 – Apr 2025) write it on separate rows every few seconds and had
  no value otherwise. A run without altitude counts as flat only when it reports
  no climb; an inclined treadmill run (500 m reported, no altitude) has no value.
- Line: median of the trailing 42 days once 3 runs are in it, broken across
  longer gaps. "About the same" within 2 s/km.
- Result: 150 of 159 runs have a value. Monthly medians run ~6:10 /km (mid-2024)
  → ~5:00–5:30 (winter 2025/26) → ~5:40 (autumn 2026), slower in both summers.
- Known limits: hilly runs still read ~15–20 s/km slower than flat ones; easy
  runs at low heart rate read slower than hard ones (heart rate isn't
  proportional to speed). The rolling median keeps both from steering the line.
