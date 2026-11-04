// Decoded streams -> one activity's detail file (activity/<id>.json).
//
// Samples fall into buckets of `step` seconds by their time; each output point is
// the mean of the bucket's present values, per channel (null when a channel has
// none there). Empty buckets (a paused watch) produce no point. `step` is 5 s,
// raised for long activities so a file never exceeds DETAIL_MAX_POINTS points.
// See docs/2026-11-04-display-files-design.md, "activity/<id>.json".

import type { DetailFile } from "./types.ts";

export const DETAIL_VERSION = 1;
export const DETAIL_STEP_S = 5;
export const DETAIL_MAX_POINTS = 1000;

type Series = (number | null)[];

/** Decoded stream channels the detail file is built from (stream channel names). */
export interface Streams {
  time: Series;
  distance?: Series;
  lat?: Series;
  lon?: Series;
  altitude?: Series;
  hr?: Series;
  speed?: Series;
  cadence?: Series;
}

/** Bucket width: 5 s, or wider so that floor(duration / step) + 1 <= DETAIL_MAX_POINTS. */
export function detailStep(durationS: number): number {
  return Math.max(DETAIL_STEP_S, Math.ceil((durationS + 1) / DETAIL_MAX_POINTS));
}

/** Detail-file key and decimal places for each shipped stream channel. */
const OUTPUT: [keyof Omit<Streams, "time">, Exclude<keyof DetailFile, "v" | "step" | "t">, number][] = [
  ["distance", "d", 0],
  ["lat", "lat", 5],
  ["lon", "lon", 5],
  ["altitude", "alt", 1],
  ["hr", "hr", 0],
  ["speed", "speed", 2],
  ["cadence", "cad", 0],
];

function round(v: number | null, dp: number): number | null {
  if (v == null) return null;
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

const hasValue = (s: Series) => s.some((v) => v != null);
const hasPositive = (s: Series) => s.some((v) => v != null && v > 0);

/**
 * Distance as a running total of the positive steps between consecutive present samples:
 * a drop (a counter reset, backward jitter) adds 0 and later increases carry on from the
 * total, so the series never decreases. Missing samples stay missing.
 */
function nonDecreasing(d: Series): Series {
  let total = 0;
  let prev: number | null = null;
  return d.map((v) => {
    if (v == null) return null;
    if (prev == null) total = v;
    else if (v > prev) total += v - prev;
    prev = v;
    return total;
  });
}

/** Bucket means: the mean time per bucket and the mean of each channel's present values. */
function bucketMeans(s: Streams, step: number, t0: number) {
  const channels = OUTPUT.map(([src]) => src).filter((c) => s[c] != null);
  const t: number[] = [];
  const out = new Map<string, Series>(channels.map((c) => [c, []]));
  let key: number | null = null;
  let tSum = 0;
  let tN = 0;
  const sums = new Map<string, { sum: number; n: number }>();

  const flush = () => {
    if (tN === 0) return;
    t.push(tSum / tN);
    for (const c of channels) {
      const acc = sums.get(c)!;
      out.get(c)!.push(acc.n > 0 ? acc.sum / acc.n : null);
    }
  };
  const reset = () => {
    tSum = 0;
    tN = 0;
    for (const c of channels) sums.set(c, { sum: 0, n: 0 });
  };

  reset();
  s.time.forEach((time, i) => {
    if (time == null) return;
    const k = Math.floor((time - t0) / step);
    if (key !== null && k !== key) {
      flush();
      reset();
    }
    key = k;
    tSum += time;
    tN += 1;
    for (const c of channels) {
      const v = s[c]![i];
      if (v == null) continue;
      const acc = sums.get(c)!;
      acc.sum += v;
      acc.n += 1;
    }
  });
  flush();
  return { t, out };
}

/** Per-point speed from distance between neighbouring points; the first copies the second. */
function speedFromDistance(t: number[], d: Series): Series {
  const v: Series = t.map((ti, i) => {
    if (i === 0) return null;
    const a = d[i - 1];
    const b = d[i];
    const dt = ti - t[i - 1];
    return a == null || b == null || dt <= 0 ? null : (b - a) / dt;
  });
  if (v.length > 1) v[0] = v[1];
  return v;
}

/** The detail file for one activity, or null when it has nothing worth charting. */
export function buildDetail(s: Streams): DetailFile | null {
  const times = s.time.filter((v): v is number => v != null);
  if (times.length === 0) return null;
  const t0 = times[0];
  const step = detailStep(times[times.length - 1] - t0);
  const { t, out } = bucketMeans(s.distance ? { ...s, distance: nonDecreasing(s.distance) } : s, step, t0);

  // Indoor sessions carry a distance/speed stream of zeros: that is "no distance".
  const d = out.get("distance");
  if (d && !hasPositive(d)) out.delete("distance");
  const speed = out.get("speed");
  if (speed && !hasPositive(speed)) out.delete("speed");
  if (!out.has("speed") && out.has("distance")) {
    out.set("speed", speedFromDistance(t, out.get("distance")!));
  }

  const detail: DetailFile = { v: DETAIL_VERSION, step, t: t.map((v) => Math.round(v)) };
  for (const [src, key, dp] of OUTPUT) {
    const series = out.get(src);
    if (!series || !hasValue(series)) continue;
    detail[key] = series.map((v) => round(v, dp));
  }
  if (!detail.alt && !detail.hr && !detail.speed) return null;
  return detail;
}
