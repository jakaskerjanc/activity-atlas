// Running fitness on the Analytics page: each visible run's efficiency (activities.json's
// grade-adjusted metres per heartbeat, scripts/fitness.ts) as the pace it would buy on flat
// ground at a fixed heart rate, corrected for the climbing the grade adjustment leaves in,
// a rolling line through those paces, and the line now against the line a year earlier.
// A faster pace means fitter. The reference heart rate only scales the numbers: the line's
// shape doesn't depend on it. Pure module, no React.

import type { ActivityRecord } from "./types";
import { monthIndex, monthStart } from "./format";

/** The heart rate the paces are read at, for readability only. */
export const REFERENCE_HR = 150;
/** The rolling line is the mean of the runs in the trailing this many days… */
export const ROLLING_DAYS = 91;
/** …once there are at least this many… */
export const ROLLING_MIN_RUNS = 5;
/** …and only while the newest of them is at most this many days old: a gap otherwise. */
export const LINE_GAP_DAYS = 28;
/** The line is evaluated every this many days, back from the newest run. */
export const LINE_STEP_DAYS = 7;
/** The climb correction is fitted once at least this many runs share a time bin with another. */
export const MIN_FIT_RUNS = 20;
/** The climb correction's time bins, in calendar months (UTC). */
export const FIT_BIN_MONTHS = 2;

const DAY_S = 86_400;
const YEAR_S = 365 * DAY_S;

/** Flat-ground pace (seconds per km) that an efficiency in metres per beat buys at `hr`. */
export function paceAt(efficiency: number, hr = REFERENCE_HR): number {
  return 1000 / (efficiency * (hr / 60));
}

/** A run that can be on the chart: a Run with an efficiency, a distance and a climb. */
interface Measured {
  activity: ActivityRecord;
  /** flat-ground pace at REFERENCE_HR, s/km, before the climb correction */
  pace: number;
  /** elevation gain per km of distance, m/km */
  climb: number;
}

function measured(activities: readonly ActivityRecord[]): Measured[] {
  const out: Measured[] = [];
  for (const a of activities) {
    if (a.type !== "Run" || a.efficiency == null || !Number.isFinite(a.efficiency) || a.efficiency <= 0) continue;
    if (a.distance == null || !(a.distance > 0) || a.elevation_gain == null || !Number.isFinite(a.elevation_gain)) {
      continue;
    }
    out.push({ activity: a, pace: paceAt(a.efficiency), climb: a.elevation_gain / (a.distance / 1000) });
  }
  return out;
}

/** One run for the climb fit. */
export interface FitRun {
  /** epoch seconds */
  ts: number;
  /** s/km */
  pace: number;
  /** m/km */
  climb: number;
}

/**
 * The climb correction, s/km per (m climbed per km): the slope of pace on climb per km by
 * ordinary least squares with a level for each FIT_BIN_MONTHS-month time bin (fixed
 * effects), so a change in fitness over time isn't read as an effect of hills. Each bin's
 * means are taken out of both pace and climb, then the slope goes through the rest.
 * 0 when fewer than MIN_FIT_RUNS runs share a bin with another (a lone run in a bin says
 * nothing about the slope) or when their climbs don't vary; never below 0, since climbing
 * can't make a run read faster for its fitness.
 */
export function climbSlope(runs: readonly FitRun[]): number {
  const bins = new Map<number, FitRun[]>();
  for (const r of runs) {
    if (!Number.isFinite(r.pace) || !Number.isFinite(r.climb)) continue;
    const bin = Math.floor(monthIndex(r.ts) / FIT_BIN_MONTHS);
    const list = bins.get(bin);
    if (list) list.push(r);
    else bins.set(bin, [r]);
  }
  let n = 0;
  let sxy = 0;
  let sxx = 0;
  for (const list of bins.values()) {
    if (list.length < 2) continue;
    n += list.length;
    const mx = list.reduce((s, r) => s + r.climb, 0) / list.length;
    const my = list.reduce((s, r) => s + r.pace, 0) / list.length;
    for (const r of list) {
      sxy += (r.climb - mx) * (r.pace - my);
      sxx += (r.climb - mx) ** 2;
    }
  }
  if (n < MIN_FIT_RUNS || !(sxx > 1e-9)) return 0;
  return Math.max(0, sxy / sxx);
}

/** The climb correction fitted over these activities' runs (pass all of them, not the visible ones). */
export function climbCorrection(activities: readonly ActivityRecord[]): number {
  return climbSlope(measured(activities).map((m) => ({ ts: m.activity.ts, pace: m.pace, climb: m.climb })));
}

/** One run on the chart. */
export interface FitnessPoint {
  id: string;
  name: string;
  /** epoch seconds */
  ts: number;
  /** flat-ground pace at REFERENCE_HR corrected for climbing, s/km */
  pace: number;
  /** the same before the climb correction, s/km */
  rawPace: number;
  /** elevation gain per km, m/km */
  climb: number;
}

/**
 * The runs with a value, oldest first: each one's pace less `slope` × its climb per km
 * (climbCorrection's slope). Other types never have one; a run without a distance or an
 * elevation gain is left out, since it can't be corrected.
 */
export function fitnessPoints(activities: readonly ActivityRecord[], slope: number): FitnessPoint[] {
  return measured(activities)
    .map(({ activity: a, pace, climb }) => ({
      id: a.id,
      name: a.name,
      ts: a.ts,
      pace: pace - slope * climb,
      rawPace: pace,
      climb,
    }))
    .sort((a, b) => a.ts - b.ts);
}

/** A point on the rolling line. */
export interface LinePoint {
  /** epoch seconds: the window's end */
  ts: number;
  /** mean pace of the runs in the window, s/km */
  pace: number;
  /** its standard error (sample standard deviation / √n), s/km */
  se: number;
  /** runs in the window */
  runs: number;
}

/**
 * The rolling line as runs of unbroken points, oldest first (points sorted by ts). It is
 * evaluated every LINE_STEP_DAYS days back from the newest run; each point is the mean
 * pace of the runs in the ROLLING_DAYS before it (the end included, exactly ROLLING_DAYS
 * back not), when there are at least ROLLING_MIN_RUNS of them and the newest is at most
 * LINE_GAP_DAYS old. A date that fails either has no point, and the line breaks there
 * instead of bridging the gap.
 */
export function rollingLine(points: readonly FitnessPoint[]): LinePoint[][] {
  if (points.length === 0) return [];
  const first = points[0].ts;
  const ends: number[] = [];
  for (let t = points[points.length - 1].ts; t >= first; t -= LINE_STEP_DAYS * DAY_S) ends.push(t);
  ends.reverse();

  const segments: LinePoint[][] = [];
  let current: LinePoint[] | null = null;
  let from = 0;
  let to = 0; // points[from, to) are in the window
  for (const t of ends) {
    while (to < points.length && points[to].ts <= t) to += 1;
    while (from < to && points[from].ts <= t - ROLLING_DAYS * DAY_S) from += 1;
    const n = to - from;
    if (n < ROLLING_MIN_RUNS || points[to - 1].ts < t - LINE_GAP_DAYS * DAY_S) {
      current = null;
      continue;
    }
    let sum = 0;
    for (let i = from; i < to; i++) sum += points[i].pace;
    const mean = sum / n;
    let ss = 0;
    for (let i = from; i < to; i++) ss += (points[i].pace - mean) ** 2;
    const point = { ts: t, pace: mean, se: Math.sqrt(ss / (n - 1) / n), runs: n };
    if (!current) {
      current = [];
      segments.push(current);
    }
    current.push(point);
  }
  return segments;
}

/**
 * The line's newest point against the line a year before it: the last point at or before
 * 365 days earlier. Null when the line doesn't reach back a year, or when that point is
 * more than LINE_GAP_DAYS older than the date (a gap in the running then).
 */
export function fitnessComparison(line: readonly LinePoint[][]): { now: LinePoint; then: LinePoint } | null {
  const all = line.flat();
  const now = all[all.length - 1];
  if (!now) return null;
  const target = now.ts - YEAR_S;
  let then: LinePoint | undefined;
  for (const p of all) {
    if (p.ts > target) break;
    then = p;
  }
  if (!then || then.ts < target - LINE_GAP_DAYS * DAY_S) return null;
  return { now, then };
}

/** Pace axis steps, in seconds: each a whole step of a clock. */
const PACE_STEPS = [5, 10, 15, 30, 60, 120, 300, 600];

/**
 * Pace axis ticks (s/km) covering [min, max]: multiples of the smallest clock step that
 * needs at most maxTicks + 1 of them, from the one at or below min to the one at or above
 * max (and at least two).
 */
export function paceTicks(min: number, max: number, maxTicks: number): number[] {
  for (const step of PACE_STEPS) {
    const lo = Math.floor(min / step) * step;
    const hi = Math.max(Math.ceil(max / step) * step, lo + step);
    if ((hi - lo) / step + 1 > maxTicks + 1 && step !== PACE_STEPS[PACE_STEPS.length - 1]) continue;
    const ticks: number[] = [];
    for (let t = lo; t <= hi; t += step) ticks.push(t);
    return ticks;
  }
  return [];
}

/** Time axis month steps: every month, then every 2, 3 or 6, then years. */
const MONTH_STEPS = [1, 2, 3, 6, 12];
const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

/**
 * Time axis ticks: the month starts inside [from, to] (epoch seconds) on the smallest
 * month step that gives at most maxTicks of them (calendar-aligned: a 3-month step
 * lands on Jan, Apr, Jul, Oct). A January is labelled with its year, other months
 * with their short name.
 */
export function timeTicks(from: number, to: number, maxTicks: number): { ts: number; label: string }[] {
  const first = monthIndex(from) + (monthStart(monthIndex(from)) < from ? 1 : 0);
  const last = monthIndex(to);
  for (const step of MONTH_STEPS) {
    const months: number[] = [];
    for (let m = first; m <= last; m++) if (m % step === 0) months.push(m);
    if (months.length > maxTicks && step !== 12) continue;
    return months.map((m) => ({
      ts: monthStart(m),
      label: m % 12 === 0 ? String(m / 12) : MONTH_NAME.format(monthStart(m) * 1000),
    }));
  }
  return [];
}
