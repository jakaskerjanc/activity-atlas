// The elevation profiles chart on the Analytics page (#16): every visible activity's
// route profile (elevation relative to its start, against distance in km) drawn as its
// own line, all overlaid. Lines are translucent, so a climb you repeat darkens where
// its runs stack up, and one-off outings stay faint. Pure module, no React;
// ui/ElevationProfiles.tsx draws the lines and finds the one under the pointer.

import { quantile } from "./stats";

/** The longest profiles run off the right edge past this quantile, so the long rides
 * (mostly flat after their climbs) don't squeeze every run and hike into the left third. Elevation is never cut: the y
 * axis always reaches the highest and lowest point drawn. */
const X_QUANTILE = 0.85;

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
  /** How many lines run past the right edge. */
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
  // Whole km, or whole 5 km once the axis is past 10 km.
  const longest = quantile(lengths, X_QUANTILE);
  const xMaxM = ceilTo(longest, longest > 10_000 ? 5000 : 1000);
  // The highest and lowest point drawn: a long ride's summit past the right edge
  // doesn't stretch the axis for a part nobody sees.
  const shown = lines.map((l) => l.profile.slice(0, Math.ceil(xMaxM / step) + 1));
  const yMax = ceilTo(Math.max(...shown.map((p) => Math.max(...p))), 10);
  const yMin = floorTo(Math.min(...shown.map((p) => Math.min(...p))), 10);
  const cut = lengths.filter((l) => l > xMaxM).length;
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

/**
 * The y axis for an elevation extent: the domain rounded out to whole ticks, so the top
 * and bottom gridlines sit on the plot's edges and no line ever runs past a labelled
 * tick. Of the nice steps (1, 2, 2.5 or 5 × 10ⁿ m) giving 4 to `maxTicks` ticks, the one
 * wasting the least room wins: an 840 m top ends the axis at 900, not 1000.
 */
export function elevationAxis(
  yMin: number,
  yMax: number,
  maxTicks = 8,
): { lo: number; hi: number; ticks: number[] } {
  const span = Math.max(yMax - yMin, 1);
  let best: { lo: number; hi: number; step: number } | null = null;
  for (let e = Math.floor(Math.log10(span)) - 2; e <= Math.ceil(Math.log10(span)); e++) {
    for (const k of [1, 2, 2.5, 5]) {
      const step = k * 10 ** e;
      const lo = Math.floor(yMin / step) * step;
      const hi = Math.max(lo + step, Math.ceil(yMax / step) * step);
      const n = Math.round((hi - lo) / step) + 1;
      if (n < 4 || n > Math.max(4, maxTicks)) continue;
      if (!best || hi - lo < best.hi - best.lo || (hi - lo === best.hi - best.lo && step > best.step)) {
        best = { lo, hi, step };
      }
    }
  }
  const { lo, hi, step } = best ?? { lo: Math.floor(yMin), hi: Math.ceil(yMax) + 1, step: span };
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(Math.round(v));
  return { lo, hi, ticks };
}

/**
 * Line opacity for `n` overlaid profiles: dense enough that one or a handful read as
 * solid lines, light enough that hundreds still show where they stack.
 */
export function lineAlpha(n: number): number {
  return Math.min(0.85, Math.max(0.12, 2.6 / Math.sqrt(Math.max(1, n))));
}
