// One activity's route profile for profiles.json: its elevation every PROFILE_STEP_M
// metres of distance, in whole metres relative to the start (so a loop starts and ends
// near 0, wherever it was). Built from the detail file's samples, so it inherits their
// 5 s bucket means, then smoothed with a centred 3-point mean to take the remaining
// GPS/barometer jitter off the shape. Read by the Analytics elevation profiles chart (#16).

import type { DetailFile } from "./types.ts";

export const PROFILES_VERSION = 1;
export const PROFILE_STEP_M = 100;

/**
 * The route profile of a detail file: point i is the elevation at i * step metres from
 * the start, minus the elevation at the start. Null when the activity has no distance
 * and altitude at two or more common samples, or covers less than one step.
 */
export function routeProfile(detail: DetailFile, step = PROFILE_STEP_M): number[] | null {
  const { d, alt } = detail;
  if (!d || !alt) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = alt[i];
    if (x == null || y == null) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 2) return null;
  const start = xs[0];
  const points = Math.floor((xs[xs.length - 1] - start) / step) + 1;
  if (points < 2) return null;

  // Linear interpolation at each step. `d` never decreases (detail.ts), so one forward
  // walk finds every point's segment.
  const resampled: number[] = [];
  let j = 0;
  for (let b = 0; b < points; b++) {
    const x = start + b * step;
    while (j < xs.length - 2 && xs[j + 1] < x) j++;
    const x0 = xs[j];
    const x1 = xs[j + 1];
    resampled.push(x1 > x0 ? ys[j] + ((ys[j + 1] - ys[j]) * (x - x0)) / (x1 - x0) : ys[j + 1]);
  }

  const smoothed = resampled.map((_, b) => {
    const lo = Math.max(0, b - 1);
    const hi = Math.min(points - 1, b + 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += resampled[k];
    return sum / (hi - lo + 1);
  });
  return smoothed.map((v) => Math.round(v - smoothed[0]) || 0);
}
