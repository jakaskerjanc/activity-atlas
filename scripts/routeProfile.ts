// One activity's route profile for profiles.json: its elevation at PROFILE_BINS evenly
// spaced fractions of its distance (0%, ..., 100%), in whole metres. Built from the
// detail file's samples, so it inherits their 5 s bucket means, then smoothed with a
// centred 3-point mean to take the remaining GPS/barometer jitter off the shape.
// Read by the Analytics ridgeline (#20, app/src/ridgeline.ts).

import type { DetailFile } from "./types.ts";

export const PROFILES_VERSION = 1;
export const PROFILE_BINS = 64;

/**
 * The route profile of a detail file, or null when it has no distance and altitude
 * at two or more common samples, or covers no distance.
 */
export function routeProfile(detail: DetailFile, bins = PROFILE_BINS): number[] | null {
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
  const span = xs[xs.length - 1] - start;
  if (!(span > 0)) return null;

  // Linear interpolation at each bin's distance. `d` never decreases (detail.ts), so one
  // forward walk finds every bin's segment.
  const resampled: number[] = [];
  let j = 0;
  for (let b = 0; b < bins; b++) {
    const x = start + (span * b) / (bins - 1);
    while (j < xs.length - 2 && xs[j + 1] < x) j++;
    const x0 = xs[j];
    const x1 = xs[j + 1];
    resampled.push(x1 > x0 ? ys[j] + ((ys[j + 1] - ys[j]) * (x - x0)) / (x1 - x0) : ys[j + 1]);
  }

  return resampled.map((_, b) => {
    const lo = Math.max(0, b - 1);
    const hi = Math.min(bins - 1, b + 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += resampled[k];
    return Math.round(sum / (hi - lo + 1));
  });
}
