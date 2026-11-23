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

## Revised (2026-11-23, after the owner saw the card)

The owner found the chart looked very bad. A spike on the 151 runs with a value
showed why, and the owner agreed these changes:

- **The window was the ugly part.** The 42-day median wobbled 8.7 s/km from week
  to week; a 91-day trailing mean of the same per-run values wobbles ~3.5 s/km
  (2.7 s/km as built, after the climb correction). The line is now the **mean of
  the trailing 91 days**, evaluated **weekly** back from the newest run, needing
  **5 runs** in the window, and **broken** (not interpolated) when the newest run
  in the window is over **28 days** old. A faint **±1 standard-error** band
  (sample s.d. / √n) shows how sure each point is; it reads well, so it stays.
- **Climbing still biased the value.** Even after Minetti, hillier runs read
  slower. The card now shows **corrected pace = pace at 150 bpm − g × climb per
  km** (the run's elevation gain ÷ its distance in km). `g` is **fitted from the
  data on every load** in `app/src/fitness.ts` (`climbSlope`): ordinary least
  squares of pace on climb per km with a fixed effect per **two-month time bin**
  (both demeaned within bins, then the slope), so fitness changing over time
  isn't mistaken for an effect of hills. It is fitted over **all** runs with a
  value and a climb, not the filtered ones, so the activity filter never moves
  it. Guards: **g = 0** when fewer than **20** runs share a bin with another run,
  or the climbs don't vary; g is **clamped ≥ 0**. A run without a distance or
  elevation gain is left out (it can't be corrected); the treadmill exclusion
  stays at build time.
- **Why in the app, not the build:** the inputs (efficiency, distance, elevation
  gain) are already on `ActivityRecord`, so no wire-format change, and the fit
  is a pure function tested on its own.
- **Heart-rate term dropped.** The spike's regression also had an average-HR
  term; it barely changed anything, so the owner chose to leave it out.
- **Per-run scatter stays** (~28 s/km s.d.): the dots show it honestly.
- **Labels:** subtitle "Flat-ground pace at 150 bpm, corrected for climbing ·
  estimate"; a note under the chart says it is an estimate from pace, heart rate
  and climbing, not a VO2max, and states the fitted correction. Hover shows the
  corrected value, the climb per km and the value before the correction.

On the real data (147 runs with a value and a climb): **g ≈ 0.84 s/km per
(m climbed per km)** (spike: ≈ 0.9 with a slightly different model). The
correlation of the value with climb per km drops from **0.18 to 0.01** (within
time bins 0.20 to 0.00). The line runs ~6:00 /km in mid-2024, is best at
**~5:16–5:19 in Feb–Apr 2026**, and reads **5:37 /km** at the newest run
(25 Oct 2026), against 6:04 a year before; slower stretches in late summer and
autumn of 2025 and summer 2026.

## Revised presentation (2026-11-23, "option A")

The owner picked a headline-first card over the dots-and-band chart. The number,
the climb correction and the 91-day line are unchanged; only the presentation is:

- **Headline**: the line's latest value, large ("5:37 /km"), with the change
  against the line a year earlier beside it ("▲ 27 s/km faster than a year ago"
  in a success green; "▼ … slower" muted, never an alarm red; "About the same"
  within 2 s/km; left out when there is no line a year earlier, the same rule
  the sentence used). "as of Oct 25" when the latest value is over a week old.
- **Best**: a muted line under it, the fastest line value ("Best: 5:16 /km in
  Mar 2026").
- **Chart: the line only.** No per-run dots and no ±1 SE band. Two direct
  labels: "Now 5:37" right of the line's end and "Best 5:16" above its fastest
  point (just the values on a phone); the best one is left out when it reads the
  same as the latest or would run into it.
- **Breaks** are bridged by a faint dotted connector (same hue, thinner, lower
  opacity) from the last value before to the first after; none before the
  first value or after the last. `lineGaps` gives them; the gap rules are
  untouched. Hovering inside one names why (`noLineReason`): "No runs Oct 20,
  2024 – Dec 26, 2024", or too few runs for a 3-month average.
- **Hover** snaps a crosshair to the nearest weekly date (`lineDates`): the
  date, the value and how many runs the 3-month window averages.
- **Footer**: "Flat-ground pace at 150 bpm, corrected for climbing · 3-month
  average · an estimate from pace, heart rate and climbing, not VO2max.", then
  the fitted correction in a second muted sentence. The card has no subtitle.

On the real data (23 Nov 2026): **5:37 /km as of Oct 25**, **▲ 27 s/km faster**
than a year ago (6:04 in Oct 2025), **best 5:16 in Mar 2026**; two breaks,
Nov–Dec 2024 and Feb–Mar 2025.

**Then (same day): no hero number.** In the page the large number didn't fit
the other Analytics cards, so the owner dropped it. The latest value, the change
and the best now sit in one lead line styled like Year against year's (value in
strong mono, the rest muted): "5:37 /km as of Oct 25, 27 s/km faster than a
year ago · best 5:16 /km in Mar 2026" ("now" when the value is this week's; no
arrows or green). What the number is moved into the card's subtitle; the footer
keeps "not VO2max" and the fitted correction.
