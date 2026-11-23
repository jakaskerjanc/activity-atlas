# Running fitness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Analytics card, "Running fitness", that plots each run's grade-adjusted efficiency as flat-ground pace at 150 bpm, with a rolling line that goes up when the owner gets fitter.

**Architecture:** `scripts/fitness.ts` (pure) turns one run's decoded streams into metres per heartbeat, grade-adjusted with Minetti (2002); `build-tracks.ts` writes it as `efficiency` on Run records in activities.json. `app/src/fitness.ts` (pure) turns the visible runs into points, a rolling line and a year-ago comparison; `app/src/ui/RunningFitness.tsx` draws them in the Analytics page.

**Tech Stack:** TypeScript, node:test (scripts), Vitest + react-dom/server (app), React 19 SVG.

**Spec:** docs/2026-11-23-running-fitness-design.md

## Global Constraints

- Type `Run` only. Absent = unknown, never 0: no value is written for a run the method can't measure.
- Minetti cost: `C(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6` (J/kg/m, i a fraction). Adjusted distance = distance × C(i) / C(0).
- First 10 minutes skipped (elapsed time from the first sample). Shown as `1000 / (efficiency × 150/60)` s/km; faster is up.
- Keep `scripts/types.ts` and `app/src/types.ts` in sync; add the term to CONTEXT.md; list the card in `ANALYTICS_SECTIONS`.
- Tunable (my call, checked on real data in Task 2): grade window 50 m, grade clamp ±0.30, stopped below 1.5 m/s, gap over 60 s (zones.ts's MAX_SAMPLE_GAP_S) is a pause, under 10 min kept → no value, rolling median over the trailing 42 days with at least 3 runs.

## Review Focus

- A run without an altitude channel (treadmill): treated as flat, still gets a value.
- Altitude noise on a stationary/slow stretch: the grade window is over distance, so a stop can't blow up the grade (stopped samples are dropped anyway).
- A sample with heart rate 0 or missing: counts neither metres nor beats.
- Run switched off in the type selection, or runs without values only: the card says so, no empty chart.
- A date range shorter than a year: no "a year ago" sentence.

---

### Task 1: Efficiency from streams

**Files:**
- Create: `scripts/fitness.ts`, `scripts/fitness.test.ts`
- Modify: `scripts/build-tracks.ts` (call it for Run rows), `scripts/numbers.ts` (`toRecord` takes it), `scripts/types.ts` + `app/src/types.ts` (`efficiency?: number`), `scripts/build-tracks.test.ts`

**Interfaces:**
- Produces: `runEfficiency(streams: Streams): number | undefined` — grade-adjusted metres per heartbeat over the kept samples, rounded to 4 decimals; `minettiCost(grade: number): number`; constants `WARMUP_S = 600`, `MIN_KEPT_S = 600`, `MIN_SPEED_MS = 1.5`, `GRADE_WINDOW_M = 50`, `MAX_GRADE = 0.3`.
- Produces: `ActivityRecord.efficiency?: number` ("grade-adjusted metres per heartbeat after the warm-up; Run only").

Algorithm (per interval i → i+1, like zoneSeconds): skip when time, distance or hr is missing, hr ≤ 0, dt ≤ 0 or > 60 s, t0 − t_first < WARMUP_S, or ds/dt < MIN_SPEED_MS. Grade at the interval's midpoint distance = (alt at d + W/2 − alt at d − W/2) / W, altitudes interpolated linearly along distance, clipped to the run's ends; clamped to ±MAX_GRADE; 0 without altitude. Adjusted metres += ds × C(g)/C(0); beats += hr × dt / 60; kept += dt. Undefined when kept < MIN_KEPT_S.

- [ ] **Step 1: Failing tests** in `scripts/fitness.test.ts`:
  - `minettiCost(0) === 3.6`; `minettiCost(0.1) > minettiCost(0)`; `minettiCost(-0.1) < minettiCost(0)`.
  - flat run, 3 m/s at 150 bpm for 30 min, 1 s samples: `runEfficiency ≈ 3 / 2.5 = 1.2` (hand-checked: 3 m per second ÷ 2.5 beats per second).
  - climb-and-descend loop at the same speed and hr (10% up for half, 10% down for half): value > the flat run's (C(0.1)+C(−0.1) > 2·C(0)).
  - warm-up excluded: a run whose first 10 min are at 100 bpm and the rest as the flat run gives the flat run's value.
  - pauses and walking excluded: inserting a 5-min gap and a stretch at 1 m/s doesn't change the value.
  - too short: 19 min of running (9 kept) → undefined; no hr → undefined; no distance → undefined.
  - no altitude channel: same as flat.
- [ ] **Step 2:** `pnpm test` → FAIL (module missing).
- [ ] **Step 3:** Implement `scripts/fitness.ts`; pass `efficiency` through `toRecord` (new optional parameter after hrZones), computed in `readDisplayFiles` only for `row.type === "Run"` with decoded streams.
- [ ] **Step 4:** `pnpm test` → PASS; add a build-tracks test that a Run with streams gets `efficiency` and a Ride with the same streams doesn't.
- [ ] **Step 5:** Commit `feat: build writes each run's grade-adjusted efficiency`.

### Task 2: Check against real data and tune

- [ ] **Step 1:** Script in the scratchpad (not committed): for every visible Run, print date, distance, climb, kept minutes, efficiency, pace at 150 bpm; also the same without grade adjustment.
- [ ] **Step 2:** Check: hilly and flat runs of the same weeks land close together (grade adjustment works); values aren't dominated by climb (correlation of pace with climb/km small); a trend is visible. If not, stop and report. Adjust thresholds; record picks in the PR.
- [ ] **Step 3:** If thresholds changed, update constants and tests; commit `fix:`.

### Task 3: Points, rolling line, year-ago comparison

**Files:**
- Create: `app/src/fitness.ts`, `app/src/fitness.test.ts`

**Interfaces:**
- Produces:
  - `REFERENCE_HR = 150`, `ROLLING_DAYS = 42`, `ROLLING_MIN_RUNS = 3`
  - `paceAt(efficiency: number, hr = REFERENCE_HR): number` (s/km)
  - `interface FitnessPoint { id: string; name: string; ts: number; pace: number }`
  - `fitnessPoints(activities: readonly ActivityRecord[]): FitnessPoint[]` — Run with a finite positive efficiency, by ts.
  - `interface LinePoint { ts: number; pace: number }`
  - `rollingLine(points: readonly FitnessPoint[]): LinePoint[]` — one per point: the median pace of points in (ts − 42 d, ts], when there are ≥ 3; otherwise none.
  - `fitnessComparison(line: readonly LinePoint[]): { now: LinePoint; then: LinePoint } | null` — `now` is the last line point; `then` the last line point at or before now.ts − 365 d, null if none or if it is more than 42 d before that date.
- [ ] **Step 1: Failing tests:** paceAt(1.2) === 1000/3 (5:33/km); fitnessPoints drops Rides, runs without efficiency, sorts; rollingLine median of [a,b,c] and of an even count (mean of middle two), no point before the 3rd run, a point drops runs older than 42 days; fitnessComparison finds the year-ago point, null when the line starts less than a year before its end, null when the nearest earlier point is > 42 d before.
- [ ] **Step 2:** `pnpm --filter app run test fitness` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Commit `feat: running fitness points, rolling line and year comparison`.

### Task 4: The card

**Files:**
- Create: `app/src/ui/RunningFitness.tsx`, `app/src/ui/RunningFitness.test.ts`
- Modify: `app/src/ui/AnalyticsView.tsx` (section `fitness`, after `zones` in `ANALYTICS_SECTIONS` and in the grid), `app/src/ui/AnalyticsView.test.ts`, `CONTEXT.md`

**Interfaces:**
- Consumes: Task 3's functions; `formatPace` from format.ts; `niceTicks`; `useElementWidth`; theme tokens.
- Produces: `RunningFitness({ activities, compact }: { activities: readonly ActivityRecord[]; compact?: boolean })`.

Chart: SVG, x = time over the points' span, y = pace with faster up (smaller s/km at the top), ticks on whole 15-second steps labelled "5:30". Dots small, muted, see-through; the line in the accent. Hover: nearest dot by x within the plot → tooltip with name, date, pace (YearAgainstYear's tooltip style). Sentence under the chart: "Faster than a year ago: 5:31 /km now, 5:58 /km in Nov 2025" (or "Slower than…", or "About the same as…" when within 2 s/km); left out when `fitnessComparison` is null. Empty: "No visible run has a fitness value." — or when no visible activity is a Run: "Switch on Run to see running fitness."
- [ ] **Step 1: Failing tests** (renderToStaticMarkup): renders the sentence for runs a year apart; omits it otherwise; the empty messages; aria-label lists the newest line pace. AnalyticsView test: section present with heading "Running fitness" and `ANALYTICS_SECTIONS` includes `{ id: "fitness", label: "Running fitness" }`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; add the CONTEXT.md term. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: running fitness card on the Analytics page`.

### Task 5: Verify

- [ ] `pnpm run test:all`, `pnpm run typecheck`, `pnpm run build` pass.
- [ ] Screenshots of the card in the dev server with real data: light, dark, phone width (390 px). Saved outside the repo.
- [ ] Push, open PR.
