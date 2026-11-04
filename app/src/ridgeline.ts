// The ridgeline on the Analytics page (#20): one ridge per month of the date range,
// oldest first, drawn from the visible activities. A ridge is the month signature: the
// per-point median of its activities' route profiles (profiles.json), so one unusual
// outing can't drag the shape. Each month also carries its known elevation gain, which
// counts every visible activity, with or without a profile. Pure module, no React.

import { aggregate } from "./stats";
import { formatMeters, formatMonth, monthIndex } from "./format";
import type { ActivityRecord } from "./types";

export interface MonthRidge {
  /** Month index (see format.ts: monthIndex). */
  month: number;
  /** Visible activities that started this month. */
  count: number;
  /** Of those, how many have a route profile, and so shape the ridge. */
  profiled: number;
  /** Summed elevation gain where known; undefined when no activity this month has one. */
  gainM: number | undefined;
  /**
   * The month signature as metres above its own lowest point, or null when no activity
   * this month has a route profile (the row draws a flat baseline).
   */
  signature: number[] | null;
  /** Highest point of the signature in metres above its lowest; 0 without a signature. */
  relief: number;
}

/** The middle value of a non-empty list (the mean of the two middle values when even). */
export function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * One ridge per month from `fromMonth` to `toMonth` (inclusive), oldest first. Months
 * without visible activities are included, so the rows keep the calendar's rhythm.
 */
export function monthRidges(
  activities: readonly ActivityRecord[],
  profiles: Readonly<Record<string, readonly number[]>>,
  fromMonth: number,
  toMonth: number,
): MonthRidge[] {
  const byMonth = new Map<number, ActivityRecord[]>();
  for (const a of activities) {
    const m = monthIndex(a.ts);
    const list = byMonth.get(m);
    if (list) list.push(a);
    else byMonth.set(m, [a]);
  }

  const ridges: MonthRidge[] = [];
  for (let month = fromMonth; month <= toMonth; month++) {
    const list = byMonth.get(month) ?? [];
    const shapes = list.map((a) => profiles[a.id]).filter((p) => p != null);
    const { elevation } = aggregate(list);
    let signature: number[] | null = null;
    let relief = 0;
    if (shapes.length > 0) {
      const bins = Math.min(...shapes.map((p) => p.length));
      const med = Array.from({ length: bins }, (_, i) => median(shapes.map((p) => p[i])));
      const low = Math.min(...med);
      signature = med.map((v) => v - low);
      relief = Math.max(...signature);
    }
    ridges.push({
      month,
      count: list.length,
      profiled: shapes.length,
      gainM: elevation.n === 0 ? undefined : elevation.sum,
      signature,
      relief,
    });
  }
  return ridges;
}

/**
 * Ridge height in pixels for `metres` above a month's lowest point. One scale for every
 * row, so ridges compare fairly: the tallest relief in view (`maxRelief`) reaches
 * `maxPx`. The scale is a square root, so a month of rolling 30 m runs still shows a
 * shape beside a 700 m mountain month, and a taller ridge always means more relief.
 */
export function ridgeHeight(metres: number, maxRelief: number, maxPx: number): number {
  if (!(maxRelief > 0) || !(metres > 0)) return 0;
  return maxPx * Math.sqrt(Math.min(metres, maxRelief) / maxRelief);
}

/**
 * SVG path data for one ridge, with its baseline at y = 0 (up is negative y): the
 * outline `line`, and `area`, the outline closed down to the baseline. x runs from 0 to
 * `width`. Empty strings without a signature.
 */
export function ridgePaths(
  signature: readonly number[] | null,
  width: number,
  maxRelief: number,
  maxPx: number,
): { line: string; area: string } {
  if (!signature || signature.length < 2) return { line: "", area: "" };
  const step = width / (signature.length - 1);
  const pts = signature.map(
    (m, i) => `${r(i * step)},${r(-ridgeHeight(m, maxRelief, maxPx))}`,
  );
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

/** The row's accessible name, e.g. "August 2026 · 23 activities · 3,817 m gain". */
export function ridgeLabel(ridge: MonthRidge): string {
  const month = formatMonth(ridge.month);
  if (ridge.count === 0) return `${month} · no activities`;
  const count = `${ridge.count} ${ridge.count === 1 ? "activity" : "activities"}`;
  const gain = ridge.gainM == null ? "elevation gain unknown" : `${formatMeters(ridge.gainM)} m gain`;
  return `${month} · ${count} · ${gain}`;
}
