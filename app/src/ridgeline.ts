// The climbing ridgeline on the Analytics page (#20): one ridge per month of the date
// range, oldest first. Along each ridge x is the day of the month (UTC, like the
// activity calendar) and the height is the elevation gain of that day's visible
// activities, drawn as a narrow bell inside the day so a ridge reads as a shape rather
// than bars, but never suggests climbing on a day without any. Ridges share one height
// scale, so months compare fairly. Each month also carries its summed gain. Pure
// module, no React; reads only activities.json.

import { aggregate } from "./stats";
import { formatDate, formatMeters, formatMonth, monthIndex, monthStart } from "./format";
import type { ActivityRecord } from "./types";

const DAY_SEC = 86400;
/** The widest month: every ridge is drawn on a 31-day axis, so shorter months end early. */
export const AXIS_DAYS = 31;
/** Curve points per day. */
export const POINTS_PER_DAY = 4;
/**
 * Smoothing: each day's gain is a bell this many days wide (standard deviation). Narrow
 * enough that a day's bell has all but vanished at the next day's middle, so a ridge
 * never shows climbing on a day without any.
 */
export const SPREAD_DAYS = 0.28;

/** One activity's share of a day, for the ridgeline's day tooltip. */
export interface DayActivity {
  id: string;
  name: string;
  type: string;
  /** Elevation gain, metres; undefined when unknown. */
  gainM: number | undefined;
}

export interface MonthRidge {
  /** Month index (see format.ts: monthIndex). */
  month: number;
  /** Days in the month. */
  days: number;
  /** Visible activities that started this month. */
  count: number;
  /** Summed elevation gain where known; undefined when no activity this month has one. */
  gainM: number | undefined;
  /** Known gain per day of the month (index 0 = the 1st); 0 for days without. */
  daily: number[];
  /** The visible activities per day of the month (index 0 = the 1st). */
  byDay?: DayActivity[][];
  /** Days (1-based) with at least one visible activity, gain known or not. */
  activeDays: number[];
  /** The day with the most gain, or undefined when no day has any. */
  biggestDay: { day: number; gainM: number } | undefined;
  /**
   * The ridge: smoothed gain in metres at POINTS_PER_DAY points per day, from the start
   * of the 1st to the end of the last day. A lone day peaks at its own gain. Null when
   * the month has no known gain (a flat baseline).
   */
  curve: number[] | null;
}

export interface ClimbingRidgeline {
  ridges: MonthRidge[];
  /** The highest point of any ridge, in metres: the shared height scale. */
  maxM: number;
}

/** Days in a month index. */
export function daysInMonth(month: number): number {
  return Math.round((monthStart(month + 1) - monthStart(month)) / DAY_SEC);
}

/**
 * The smoothed curve for a month's daily gains: a bell of SPREAD_DAYS around the middle
 * of each day, scaled so a lone day's peak equals its gain; neighbouring days add up.
 */
export function smoothDaily(daily: readonly number[]): number[] {
  const n = daily.length * POINTS_PER_DAY + 1;
  return Array.from({ length: n }, (_, i) => {
    const x = i / POINTS_PER_DAY;
    let sum = 0;
    daily.forEach((g, d) => {
      if (g === 0) return;
      const z = (x - (d + 0.5)) / SPREAD_DAYS;
      sum += g * Math.exp(-0.5 * z * z);
    });
    return sum;
  });
}

/**
 * One ridge per month from `fromMonth` to `toMonth` (inclusive), oldest first. Months
 * without visible activities are included, so the rows keep the calendar's rhythm.
 */
export function climbingRidgeline(
  activities: readonly ActivityRecord[],
  fromMonth: number,
  toMonth: number,
): ClimbingRidgeline {
  const byMonth = new Map<number, ActivityRecord[]>();
  for (const a of activities) {
    const m = monthIndex(a.ts);
    const list = byMonth.get(m);
    if (list) list.push(a);
    else byMonth.set(m, [a]);
  }

  const ridges: MonthRidge[] = [];
  let maxM = 0;
  for (let month = fromMonth; month <= toMonth; month++) {
    const list = byMonth.get(month) ?? [];
    const days = daysInMonth(month);
    const start = monthStart(month);
    const daily = new Array<number>(days).fill(0);
    const byDay: DayActivity[][] = Array.from({ length: days }, () => []);
    const active = new Set<number>();
    for (const a of list) {
      const d = Math.floor((a.ts - start) / DAY_SEC);
      active.add(d + 1);
      if (a.elevation_gain != null) daily[d] += a.elevation_gain;
      byDay[d].push({ id: a.id, name: a.name, type: a.type, gainM: a.elevation_gain });
    }
    const { elevation } = aggregate(list);
    const top = Math.max(0, ...daily);
    const curve = top > 0 ? smoothDaily(daily) : null;
    if (curve) maxM = Math.max(maxM, ...curve);
    ridges.push({
      month,
      days,
      count: list.length,
      gainM: elevation.n === 0 ? undefined : elevation.sum,
      daily,
      byDay,
      activeDays: [...active].sort((a, b) => a - b),
      biggestDay: top > 0 ? { day: daily.indexOf(top) + 1, gainM: top } : undefined,
      curve,
    });
  }
  return { ridges, maxM };
}

/**
 * Ridge height in pixels for `metres`, on one scale for every row: the highest point in
 * view (`maxM`) reaches `maxPx`. A square-root scale, so a typical 150 m day still shows
 * beside a 2,000 m mountain day; a taller ridge always means more climbing.
 */
export function ridgeHeight(metres: number, maxM: number, maxPx: number): number {
  if (!(maxM > 0) || !(metres > 0)) return 0;
  return maxPx * Math.sqrt(Math.min(metres, maxM) / maxM);
}

/** x of a point in days from the start of the 1st, on the AXIS_DAYS-wide axis. */
export function dayX(days: number, width: number): number {
  return (days / AXIS_DAYS) * width;
}

/**
 * SVG path data for one ridge, with its baseline at y = 0 (up is negative y): the
 * outline `line`, and `area`, the outline closed down to the baseline. The curve runs
 * from the start of the 1st to the end of the month on an AXIS_DAYS-wide axis `width`
 * pixels across. Empty strings without a curve.
 */
export function ridgePaths(
  curve: readonly number[] | null,
  width: number,
  maxM: number,
  maxPx: number,
): { line: string; area: string } {
  if (!curve || curve.length < 2) return { line: "", area: "" };
  const pts = curve.map(
    (m, i) => `${r(dayX(i / POINTS_PER_DAY, width))},${r(-ridgeHeight(m, maxM, maxPx))}`,
  );
  const line = `M${pts.join("L")}`;
  const end = r(dayX((curve.length - 1) / POINTS_PER_DAY, width));
  return { line, area: `${line}L${end},0L0,0Z` };
}

const r = (v: number) => Math.round(v * 10) / 10 || 0;

/** A month's summed elevation gain for its row: "817 m", "3.8k m"; "—" when unknown. */
export function formatGain(metres: number | undefined): string {
  if (metres == null) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)}k m`;
}

/**
 * The row's accessible name, e.g.
 * "August 2026 · 23 activities · 3,817 m gain · biggest day Aug 14, 2026: 1,204 m".
 */
export function ridgeLabel(ridge: MonthRidge): string {
  const month = formatMonth(ridge.month);
  if (ridge.count === 0) return `${month} · no activities`;
  const count = `${ridge.count} ${ridge.count === 1 ? "activity" : "activities"}`;
  const gain = ridge.gainM == null ? "elevation gain unknown" : `${formatMeters(ridge.gainM)} m gain`;
  const big = ridge.biggestDay;
  const biggest = big
    ? ` · biggest day ${formatDate(monthStart(ridge.month) + (big.day - 1) * DAY_SEC)}: ${formatMeters(big.gainM)} m`
    : "";
  return `${month} · ${count} · ${gain}${biggest}`;
}
