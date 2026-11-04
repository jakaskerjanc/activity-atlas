// The hilliness ridgeline on the Analytics page (#20): one ridge per month of the date
// range, oldest first. A ridge is the distribution of the month's visible activities
// by hilliness (metres climbed per km), as a smoothed curve: a month of flat runs is a
// sharp peak near 0, a month mixing runs and hikes has two humps. Ridges share one
// scale in activities, so a busy month stands taller than a quiet one. Each month also
// carries its summed elevation gain. Pure module, no React; reads only activities.json.

import { aggregate, median, quantile } from "./stats";
import { formatMeters, formatMonth, monthIndex } from "./format";
import type { ActivityRecord } from "./types";

/** Shorter activities are left out of the distribution: a few metres of GPS noise over
 * 300 m would read as a mountain. */
export const MIN_DISTANCE_M = 1000;
/** Points per ridge curve. */
const POINTS = 96;
/** The axis ends at this quantile of the visible hilliness, so one scramble doesn't
 * squash every other month into the left edge. */
const X_QUANTILE = 0.98;
/** Curve smoothing (the kernel's standard deviation) as a share of the axis. */
const BANDWIDTH = 1 / 40;

/** Metres climbed per km; undefined when distance or gain is unknown, or under 1 km. */
export function hilliness(a: ActivityRecord): number | undefined {
  if (a.elevation_gain == null || a.distance == null || a.distance < MIN_DISTANCE_M) {
    return undefined;
  }
  return a.elevation_gain / (a.distance / 1000);
}

export interface MonthRidge {
  /** Month index (see format.ts: monthIndex). */
  month: number;
  /** Visible activities that started this month. */
  count: number;
  /** Of those, how many have a hilliness, and so shape the ridge. */
  measured: number;
  /** Summed elevation gain where known; undefined when no activity this month has one. */
  gainM: number | undefined;
  /** Median hilliness of the measured activities, m/km; undefined without any. */
  medianMPerKm: number | undefined;
  /**
   * The ridge: activities per m/km at POINTS evenly spaced hilliness values from 0 to
   * the axis end. Null when no activity this month has a hilliness (a flat baseline).
   */
  density: number[] | null;
}

export interface HillinessRidgeline {
  ridges: MonthRidge[];
  /** Axis end in m/km (the axis starts at 0). */
  xMax: number;
  /** The highest density of any ridge: the shared height scale. */
  maxDensity: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * A smoothed distribution of `values` at `xs`: a Gaussian kernel per value, reflected at
 * 0 so the many near-flat activities don't lose half their weight below the axis. The
 * area under the curve is the number of values.
 */
export function density(values: readonly number[], xs: readonly number[], bw: number): number[] {
  return xs.map((x) => {
    let sum = 0;
    for (const v of values) {
      const a = (x - v) / bw;
      const b = (x + v) / bw;
      sum += Math.exp(-0.5 * a * a) + Math.exp(-0.5 * b * b);
    }
    return sum / (bw * SQRT_2PI);
  });
}

/**
 * One ridge per month from `fromMonth` to `toMonth` (inclusive), oldest first. Months
 * without visible activities are included, so the rows keep the calendar's rhythm.
 */
export function hillinessRidgeline(
  activities: readonly ActivityRecord[],
  fromMonth: number,
  toMonth: number,
): HillinessRidgeline {
  const byMonth = new Map<number, ActivityRecord[]>();
  const all: number[] = [];
  for (const a of activities) {
    const m = monthIndex(a.ts);
    const list = byMonth.get(m);
    if (list) list.push(a);
    else byMonth.set(m, [a]);
    const h = hilliness(a);
    if (h != null) all.push(h);
  }

  const xMax = all.length ? Math.max(10, Math.ceil(quantile(all, X_QUANTILE) / 10) * 10) : 10;
  const xs = Array.from({ length: POINTS }, (_, i) => (xMax * i) / (POINTS - 1));
  const bw = xMax * BANDWIDTH;

  const ridges: MonthRidge[] = [];
  let maxDensity = 0;
  for (let month = fromMonth; month <= toMonth; month++) {
    const list = byMonth.get(month) ?? [];
    const values = list.map(hilliness).filter((h) => h != null);
    const { elevation } = aggregate(list);
    const curve = values.length ? density(values, xs, bw) : null;
    if (curve) maxDensity = Math.max(maxDensity, ...curve);
    ridges.push({
      month,
      count: list.length,
      measured: values.length,
      gainM: elevation.n === 0 ? undefined : elevation.sum,
      medianMPerKm: values.length ? median(values) : undefined,
      density: curve,
    });
  }
  return { ridges, xMax, maxDensity };
}

/**
 * SVG path data for one ridge, with its baseline at y = 0 (up is negative y): the
 * outline `line`, and `area`, the outline closed down to the baseline. x runs from 0 to
 * `width`; the highest density of any ridge (`maxDensity`) reaches `maxPx`. Empty
 * strings without a curve.
 */
export function ridgePaths(
  curve: readonly number[] | null,
  width: number,
  maxDensity: number,
  maxPx: number,
): { line: string; area: string } {
  if (!curve || curve.length < 2) return { line: "", area: "" };
  const step = width / (curve.length - 1);
  const scale = maxDensity > 0 ? maxPx / maxDensity : 0;
  const pts = curve.map((d, i) => `${r(i * step)},${r(-d * scale)}`);
  const line = `M${pts.join("L")}`;
  return { line, area: `${line}L${r(width)},0L0,0Z` };
}

const r = (v: number) => Math.round(v * 10) / 10 || 0;

/** A month's summed elevation gain for its row: "817 m", "3.8k m"; "—" when unknown. */
export function formatGain(metres: number | undefined): string {
  if (metres == null) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)}k m`;
}

/** The row's accessible name, e.g. "August 2026 · 23 activities · 3,817 m gain · median 12 m/km". */
export function ridgeLabel(ridge: MonthRidge): string {
  const month = formatMonth(ridge.month);
  if (ridge.count === 0) return `${month} · no activities`;
  const count = `${ridge.count} ${ridge.count === 1 ? "activity" : "activities"}`;
  const gain = ridge.gainM == null ? "elevation gain unknown" : `${formatMeters(ridge.gainM)} m gain`;
  const hill = ridge.medianMPerKm == null ? "" : ` · median ${Math.round(ridge.medianMPerKm)} m/km`;
  return `${month} · ${count} · ${gain}${hill}`;
}
