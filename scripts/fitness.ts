// Running fitness for activities.json: one run's efficiency, grade-adjusted metres per
// heartbeat after the warm-up, from its full-resolution streams. Each metre is weighted
// by Minetti et al. (2002)'s energy cost of running at its grade against the cost on the
// flat, so a climb counts as more running than it looks and a steep descent as less;
// dividing by heartbeats then reads how much running the heart buys. The site shows it
// as flat-ground pace at 150 bpm. See docs/2026-11-23-running-fitness-design.md.

import type { Streams } from "./detail.ts";
import { MAX_SAMPLE_GAP_S } from "./zones.ts";

/** The first seconds are left out: a warm-up, and heart rate lags the pace. */
export const WARMUP_S = 600;
/** A run with less kept time than this has no value. */
export const MIN_KEPT_S = 600;
/** Slower than this is stopping or walking, not running: left out. */
export const MIN_SPEED_MS = 1.5;
/** Grade is rise over this much distance centred on the sample (altitude noise swamps shorter). */
export const GRADE_WINDOW_M = 50;
/** Grades beyond this are clamped: the edge of the range Minetti measured (±45%) is sparse. */
export const MAX_GRADE = 0.3;

/** Minetti et al. (2002): energy cost of running in J/kg/m at a grade (a fraction). */
export function minettiCost(i: number): number {
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

const FLAT_COST = minettiCost(0);

type Series = readonly (number | null)[];

/**
 * Altitude at a distance along the run, interpolated between the present samples around
 * it (which are sorted by distance), and held at the ends.
 */
function altitudeAlong(dist: number[], alt: number[]): (d: number) => number {
  let j = 0;
  return (d) => {
    // Calls come in roughly increasing distance; walk the cursor either way.
    while (j > 0 && dist[j] > d) j -= 1;
    while (j + 1 < dist.length && dist[j + 1] <= d) j += 1;
    if (d <= dist[0]) return alt[0];
    if (j + 1 >= dist.length) return alt[alt.length - 1];
    const span = dist[j + 1] - dist[j];
    return span > 0 ? alt[j] + ((alt[j + 1] - alt[j]) * (d - dist[j])) / span : alt[j];
  };
}

/**
 * Grade-adjusted metres per heartbeat over the run after WARMUP_S, rounded to 4 decimals.
 * Interval i → i + 1 counts when both ends have time and distance, sample i has a heart
 * rate, the interval is no pause (over MAX_SAMPLE_GAP_S) and the speed over it is at least
 * MIN_SPEED_MS. Its grade is measured over GRADE_WINDOW_M around its middle and clamped to
 * ±MAX_GRADE; without altitude the run counts as flat (a treadmill). Undefined when less
 * than MIN_KEPT_S counts: unknown, never a guess.
 */
export function runEfficiency(s: Streams): number | undefined {
  const { time, distance, hr } = s;
  if (!distance || !hr) return undefined;
  const t0 = time.find((t) => t != null);
  if (t0 == null) return undefined;

  const altDist: number[] = [];
  const altValue: number[] = [];
  const altitude: Series = s.altitude ?? [];
  for (let i = 0; i < altitude.length; i++) {
    const d = distance[i];
    const a = altitude[i];
    if (d == null || a == null) continue;
    if (altDist.length > 0 && d < altDist[altDist.length - 1]) continue; // keep it sorted
    altDist.push(d);
    altValue.push(a);
  }
  const altAt = altDist.length >= 2 ? altitudeAlong(altDist, altValue) : null;
  const half = GRADE_WINDOW_M / 2;

  let metres = 0;
  let beats = 0;
  let kept = 0;
  const n = Math.min(time.length, distance.length, hr.length);
  for (let i = 0; i + 1 < n; i++) {
    const ta = time[i];
    const tb = time[i + 1];
    const da = distance[i];
    const db = distance[i + 1];
    const h = hr[i];
    if (ta == null || tb == null || da == null || db == null || h == null || !(h > 0)) continue;
    if (ta - t0 < WARMUP_S) continue;
    const dt = tb - ta;
    if (!(dt > 0) || dt > MAX_SAMPLE_GAP_S) continue;
    const ds = db - da;
    if (ds / dt < MIN_SPEED_MS) continue;
    let grade = 0;
    if (altAt) {
      const mid = (da + db) / 2;
      grade = (altAt(mid + half) - altAt(mid - half)) / GRADE_WINDOW_M;
      grade = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, grade));
    }
    metres += (ds * minettiCost(grade)) / FLAT_COST;
    beats += (h * dt) / 60;
    kept += dt;
  }
  if (kept < MIN_KEPT_S || !(beats > 0)) return undefined;
  return Math.round((metres / beats) * 1e4) / 1e4;
}
