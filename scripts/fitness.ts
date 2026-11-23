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
/**
 * Slower than this, grade-adjusted, is stopping or strolling: left out. Adjusted, so a
 * steep climb taken at a walk still counts as the work it is.
 */
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

/** The present (x, y) pairs of two channels, in sample order, keeping x non-decreasing. */
function pairs(xs: Series, ys: Series): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const a = xs[i];
    const b = ys[i];
    if (a == null || b == null) continue;
    if (x.length > 0 && a < x[x.length - 1]) continue;
    x.push(a);
    y.push(b);
  }
  return { x, y };
}

/**
 * y at x, interpolated linearly between the present samples around it (x sorted). Two
 * samples further apart than `maxSpan` don't bridge the gap (null), nor does anything
 * outside the samples, unless `hold` keeps the end values there.
 */
function interpolator(x: number[], y: number[], maxSpan = Infinity, hold = false): (at: number) => number | null {
  let j = 0;
  return (at) => {
    if (x.length === 0) return null;
    // Calls come in roughly increasing order; walk the cursor either way.
    while (j > 0 && x[j] > at) j -= 1;
    while (j + 1 < x.length && x[j + 1] <= at) j += 1;
    if (at < x[0]) return hold ? y[0] : null;
    if (x[j] === at) return y[j];
    if (j + 1 >= x.length) return hold ? y[y.length - 1] : null;
    const span = x[j + 1] - x[j];
    if (span > maxSpan) return null;
    return y[j] + ((y[j + 1] - y[j]) * (at - x[j])) / span;
  };
}

/**
 * Grade-adjusted metres per heartbeat over the run after WARMUP_S, rounded to 4 decimals.
 * The run is read as consecutive samples with both time and distance; heart rate, which
 * some watches write on rows of its own every few seconds, is interpolated in time
 * between its samples (not across a gap over MAX_SAMPLE_GAP_S). Interval a → b counts
 * when a has a heart rate, it is no pause (over MAX_SAMPLE_GAP_S) and its grade-adjusted
 * speed is at least MIN_SPEED_MS. Its grade is measured over GRADE_WINDOW_M around its
 * middle and clamped to ±MAX_GRADE. Without altitude samples the run counts as flat (a
 * treadmill) when its reported elevation gain is 0 or unknown; one that reports climbing
 * (an inclined treadmill) has no grade to adjust by, so no value. Undefined when less than
 * MIN_KEPT_S counts: unknown, never a guess.
 */
export function runEfficiency(s: Streams, elevationGain?: number): number | undefined {
  const { time, distance, hr } = s;
  if (!distance || !hr) return undefined;
  const t0 = time.find((t) => t != null);
  if (t0 == null) return undefined;

  const run = pairs(time, distance);
  const beat = pairs(time, hr);
  const hrAt = interpolator(beat.x, beat.y, MAX_SAMPLE_GAP_S);
  const ground = pairs(distance, s.altitude ?? []);
  const altAt = ground.x.length >= 2 ? interpolator(ground.x, ground.y, Infinity, true) : null;
  if (!altAt && elevationGain != null && elevationGain > 0) return undefined;
  const half = GRADE_WINDOW_M / 2;

  let metres = 0;
  let beats = 0;
  let kept = 0;
  for (let i = 0; i + 1 < run.x.length; i++) {
    const ta = run.x[i];
    const dt = run.x[i + 1] - ta;
    if (ta - t0 < WARMUP_S || !(dt > 0) || dt > MAX_SAMPLE_GAP_S) continue;
    const h = hrAt(ta);
    if (h == null || !(h > 0)) continue;
    const da = run.y[i];
    const ds = run.y[i + 1] - da;
    let grade = 0;
    if (altAt) {
      const mid = da + ds / 2;
      grade = (altAt(mid + half)! - altAt(mid - half)!) / GRADE_WINDOW_M;
      grade = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, grade));
    }
    const adjusted = (ds * minettiCost(grade)) / FLAT_COST;
    if (adjusted / dt < MIN_SPEED_MS) continue;
    metres += adjusted;
    beats += (h * dt) / 60;
    kept += dt;
  }
  if (kept < MIN_KEPT_S || !(beats > 0)) return undefined;
  return Math.round((metres / beats) * 1e4) / 1e4;
}
