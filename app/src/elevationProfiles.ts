// The elevation profiles chart on the Analytics page (#16): every visible activity's
// route profile (elevation relative to its start, against distance in km) drawn as its
// own line, all overlaid. Lines are translucent, so a climb you repeat darkens where
// its runs stack up, and one-off outings stay faint. Pure module, no React;
// ui/ElevationProfiles.tsx draws the lines and finds the one under the pointer.

import { quantile } from "./stats";

/** The longest and highest profiles run off the chart at these quantiles, so one
 * century ride or alpine day doesn't squeeze everything else into a corner. */
const X_QUANTILE = 0.95;
const Y_QUANTILE = 0.95;

/** One activity's line. */
export interface ProfileLine {
  id: string;
  name: string;
  type: string;
  /** Start, epoch seconds. */
  ts: number;
  /** Elevation every `step` metres, relative to the start (profiles.json). */
  profile: readonly number[];
}

export interface ProfileChart {
  lines: ProfileLine[];
  /** Metres of distance between profile points. */
  step: number;
  /** Distance shown, in metres from the start (the left edge is 0). */
  xMaxM: number;
  /** Elevation shown, in metres relative to the start: bottom and top edges. */
  yMin: number;
  yMax: number;
  /** How many lines run past the right edge, or above or below the chart. */
  cut: number;
}

/** Up to the next multiple of `step` (and at least one step). */
const ceilTo = (v: number, step: number) => Math.max(step, Math.ceil(v / step) * step);
const floorTo = (v: number, step: number) => Math.min(0, Math.floor(v / step) * step);

/** The length of a profile in metres. */
export const lengthM = (line: ProfileLine, step: number) => (line.profile.length - 1) * step;

/** The chart's extents for `lines`. Null without lines. */
export function profileChart(lines: ProfileLine[], step: number): ProfileChart | null {
  if (lines.length === 0) return null;
  const lengths = lines.map((l) => lengthM(l, step));
  const highs = lines.map((l) => Math.max(...l.profile));
  const lows = lines.map((l) => Math.min(...l.profile));
  // Whole km, or whole 5 km once the axis is past 10 km.
  const longest = quantile(lengths, X_QUANTILE);
  const xMaxM = ceilTo(longest, longest > 10_000 ? 5000 : 1000);
  const yMax = ceilTo(quantile(highs, Y_QUANTILE), 10);
  const yMin = floorTo(quantile(lows, 1 - Y_QUANTILE), 10);
  const cut = lines.filter((_, i) => lengths[i] > xMaxM || highs[i] > yMax || lows[i] < yMin).length;
  return { lines, step, xMaxM, yMin, yMax, cut };
}

/** A profile's elevation `xM` metres from the start, interpolated; undefined past its end. */
export function elevationAt(profile: readonly number[], step: number, xM: number): number | undefined {
  const at = xM / step;
  if (at < 0 || at > profile.length - 1) return undefined;
  const k = Math.min(Math.floor(at), profile.length - 2);
  return profile[k] + (profile[k + 1] - profile[k]) * (at - k);
}

/**
 * The line closest to the point (`xM` metres along, `yM` metres from the start) by
 * vertical distance, if within `tolM` metres; else null. Only lines that reach `xM`
 * count. Index into chart.lines.
 */
export function nearestLine(
  chart: ProfileChart,
  xM: number,
  yM: number,
  tolM: number,
): number | null {
  let best: number | null = null;
  let bestD = tolM;
  chart.lines.forEach((l, i) => {
    const y = elevationAt(l.profile, chart.step, xM);
    if (y === undefined) return;
    const d = Math.abs(y - yM);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}
