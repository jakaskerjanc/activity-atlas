// Running fitness on the Analytics page: each visible run's efficiency (activities.json's
// grade-adjusted metres per heartbeat, scripts/fitness.ts) as the pace it would buy on flat
// ground at a fixed heart rate, a rolling line through those paces, and the line now
// against the line a year earlier. A faster pace means fitter. The reference heart rate
// only scales the numbers: the line's shape doesn't depend on it. Pure module, no React.

import type { ActivityRecord } from "./types";

/** The heart rate the paces are read at, for readability only. */
export const REFERENCE_HR = 150;
/** The rolling line is the median of the runs in the trailing this many days… */
export const ROLLING_DAYS = 42;
/** …once there are at least this many. */
export const ROLLING_MIN_RUNS = 3;

const DAY_S = 86_400;
const YEAR_S = 365 * DAY_S;

/** Flat-ground pace (seconds per km) that an efficiency in metres per beat buys at `hr`. */
export function paceAt(efficiency: number, hr = REFERENCE_HR): number {
  return 1000 / (efficiency * (hr / 60));
}

/** One run on the chart. */
export interface FitnessPoint {
  id: string;
  name: string;
  /** epoch seconds */
  ts: number;
  /** flat-ground pace at REFERENCE_HR, s/km */
  pace: number;
}

/** The visible runs with an efficiency, oldest first. Other types never have one. */
export function fitnessPoints(activities: readonly ActivityRecord[]): FitnessPoint[] {
  return activities
    .filter((a) => a.type === "Run" && a.efficiency != null && Number.isFinite(a.efficiency) && a.efficiency > 0)
    .map((a) => ({ id: a.id, name: a.name, ts: a.ts, pace: paceAt(a.efficiency!) }))
    .sort((a, b) => a.ts - b.ts);
}

/** A point on the rolling line, at a run's start. */
export interface LinePoint {
  ts: number;
  pace: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The rolling line, one point per run (points sorted by ts): the median pace of the runs
 * in the ROLLING_DAYS before it (it included, exactly ROLLING_DAYS back not), when there
 * are at least ROLLING_MIN_RUNS of them; no point otherwise. A median, so one odd run
 * doesn't swing it.
 */
export function rollingLine(points: readonly FitnessPoint[]): LinePoint[] {
  const line: LinePoint[] = [];
  let from = 0;
  for (let i = 0; i < points.length; i++) {
    const { ts } = points[i];
    while (points[from].ts <= ts - ROLLING_DAYS * DAY_S) from += 1;
    if (i + 1 - from < ROLLING_MIN_RUNS) continue;
    line.push({ ts, pace: median(points.slice(from, i + 1).map((p) => p.pace)) });
  }
  return line;
}

/**
 * The line's newest point against the line a year before it: the last point at or before
 * 365 days earlier. Null when the line doesn't reach back a year, or when that point is
 * more than ROLLING_DAYS older than the date (a gap in the running then).
 */
export function fitnessComparison(line: readonly LinePoint[]): { now: LinePoint; then: LinePoint } | null {
  const now = line[line.length - 1];
  if (!now) return null;
  const target = now.ts - YEAR_S;
  let then: LinePoint | undefined;
  for (const p of line) {
    if (p.ts > target) break;
    then = p;
  }
  if (!then || then.ts < target - ROLLING_DAYS * DAY_S) return null;
  return { now, then };
}
