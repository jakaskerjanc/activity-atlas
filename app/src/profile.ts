// Pure chart model for the selected activity's detail file: which charts to draw,
// their values in display units and y domains, plus the geometry helpers the SVG
// component uses (ticks, paths with gaps, nearest sample).
// No React / DOM. See docs/2026-11-04-display-files-design.md, "App behaviour".

import type { DetailFile } from "./types";
import { isFootBased } from "./format";

export type ChartKind = "elevation" | "hr" | "pace" | "speed" | "cadence";

type Series = (number | null)[];

export interface ChartSeries {
  kind: ChartKind;
  /** display units: m, bpm, s/km, km/h */
  values: Series;
  /** y range to draw; values outside it are clipped by the chart */
  domain: [number, number];
  /** true when smaller is better and drawn at the top (pace) */
  invert: boolean;
}

export interface Profile {
  xKind: "distance" | "time";
  /** m or s, non-decreasing, one per sample */
  x: number[];
  charts: ChartSeries[];
}

/** Below this speed (m/s) a sample is a stop: no pace is drawn there. */
const STOP_SPEED = 0.3;
const SMOOTH_WINDOW = 5;

const present = (s: Series) => s.filter((v): v is number => v != null);

/** Centred moving mean over the present values in the window; a missing sample stays missing. */
export function smoothSpeed(v: Series, window = SMOOTH_WINDOW): Series {
  const half = Math.floor(window / 2);
  return v.map((x, i) => {
    if (x == null) return null;
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(v.length - 1, i + half); j++) {
      const y = v[j];
      if (y != null) {
        sum += y;
        n += 1;
      }
    }
    return sum / n;
  });
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.round(p * (sorted.length - 1))];
}

/** [min, max], widened to at least `minSpan` around its centre. */
function span(values: number[], minSpan: number): [number, number] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < minSpan) {
    const c = (lo + hi) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
  }
  return [lo, hi];
}

function chart(kind: ChartKind, values: Series, domain: [number, number], invert = false): ChartSeries {
  return { kind, values, domain, invert };
}

function paceChart(speed: Series): ChartSeries | null {
  const values = smoothSpeed(speed).map((v) => (v != null && v >= STOP_SPEED ? 1000 / v : null));
  const sorted = present(values).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  // p5..p95, and never slower than twice the median: hikes have a long tail of slow
  // climbing that would otherwise squash the walking pace into the top of the chart.
  // Slower samples clip to the bottom edge; the readout still shows their value.
  let lo = percentile(sorted, 0.05);
  let hi = Math.min(percentile(sorted, 0.95), 2 * percentile(sorted, 0.5));
  if (hi - lo < 30) [lo, hi] = [(lo + hi) / 2 - 15, (lo + hi) / 2 + 15];
  // The axis is labelled on whole minutes: when fewer than two fall inside (a steady
  // run), widen outward to whole minutes so there are always at least two ticks.
  if (Math.floor(hi / 60) - Math.ceil(lo / 60) + 1 < 2) {
    lo = Math.floor(lo / 60) * 60;
    hi = Math.max(Math.ceil(hi / 60) * 60, lo + 60);
  }
  return chart("pace", values, [lo, hi], true);
}

function speedChart(speed: Series): ChartSeries | null {
  const values = smoothSpeed(speed).map((v) => (v == null ? null : v * 3.6));
  const p = present(values);
  if (p.length === 0) return null;
  return chart("speed", values, [0, Math.max(1, ...p)]);
}

/** The charts for one activity, or null when it has nothing to chart. */
export function buildProfile(detail: DetailFile, type: string): Profile | null {
  const charts: ChartSeries[] = [];
  if (detail.alt && present(detail.alt).length) charts.push(chart("elevation", detail.alt, span(present(detail.alt), 20)));
  if (detail.hr && present(detail.hr).length) charts.push(chart("hr", detail.hr, span(present(detail.hr), 10)));
  if (detail.speed) {
    const c = isFootBased(type) ? paceChart(detail.speed) : speedChart(detail.speed);
    if (c) charts.push(c);
  }
  // Cadence of 0 is a coasting/standing sample, not a rhythm: left out of the domain.
  const cad = detail.cad?.map((v) => (v != null && v > 0 ? v : null));
  if (cad && present(cad).length) charts.push(chart("cadence", cad, span(present(cad), 10)));
  if (charts.length === 0) return null;

  if (detail.d) {
    // Carry the last known distance over a gap so x stays non-decreasing.
    let last = 0;
    const x = detail.d.map((v) => (v == null ? last : (last = v)));
    return { xKind: "distance", x, charts };
  }
  return { xKind: "time", x: detail.t.slice(), charts };
}

/** Multiples of `step` inside [lo, hi], rounded so labels carry no float artefacts. */
function multiples(lo: number, hi: number, step: number): number[] {
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/**
 * Round tick values (1/2/5 × 10^k steps) inside [lo, hi]: about `count` of them, but
 * never fewer than two (when `hi > lo`) - the step shrinks until two fit.
 */
export function niceTicks(lo: number, hi: number, count = 3): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  let mag = 10 ** Math.floor(Math.log10(raw));
  let m = [1, 2, 5, 10].find((k) => k * mag >= raw)!;
  if (m === 10) [m, mag] = [1, mag * 10];
  for (;;) {
    const ticks = multiples(lo, hi, m * mag);
    if (ticks.length >= 2 || mag < (hi - lo) * 1e-6) return ticks;
    if (m === 5) m = 2;
    else if (m === 2) m = 1;
    else [m, mag] = [5, mag / 10];
  }
}

/**
 * Pace ticks (seconds per km): multiples of a nice whole-minute step inside [lo, hi].
 * The step shrinks (… 10, 5, 2, 1 min, never below 1) until at least two ticks fit.
 */
export function paceTicks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 60 / 3;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120];
  const found = steps.findIndex((x) => x >= raw);
  const start = found < 0 ? steps.length - 1 : found;
  let ticks: number[] = [];
  for (let i = start; i >= 0; i--) {
    ticks = multiples(lo, hi, steps[i] * 60);
    if (ticks.length >= 2) break;
  }
  return ticks;
}

const pt = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** Runs of consecutive present samples. */
function segments(y: Series): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  y.forEach((v, i) => {
    if (v != null && start < 0) start = i;
    if (v == null && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, y.length - 1]);
  return out;
}

/** SVG path of a line; a missing sample starts a new sub-path (no line across gaps). */
export function linePath(
  x: number[],
  y: Series,
  sx: (v: number) => number,
  sy: (v: number) => number,
): string {
  return segments(y)
    .map(([a, b]) => {
      let d = "M" + pt(sx(x[a]), sy(y[a]!));
      for (let i = a + 1; i <= b; i++) d += "L" + pt(sx(x[i]), sy(y[i]!));
      return d;
    })
    .join("");
}

/**
 * A line in pieces by band: one SVG path per band (index = band), each holding the
 * steps whose two ends average into that band, so the pieces join with no gap. `band`
 * maps a value to its band (a heart rate to its zone).
 */
export function bandedLinePaths(
  x: number[],
  y: Series,
  sx: (v: number) => number,
  sy: (v: number) => number,
  band: (v: number) => number,
  bands: number,
): string[] {
  const out = Array.from({ length: bands }, () => "");
  for (let i = 1; i < y.length; i++) {
    const a = y[i - 1];
    const b = y[i];
    if (a == null || b == null) continue;
    out[band((a + b) / 2)] += "M" + pt(sx(x[i - 1]), sy(a)) + "L" + pt(sx(x[i]), sy(b));
  }
  return out;
}

/** SVG path of a filled area: one closed shape per run of present samples. */
export function areaPath(
  x: number[],
  y: Series,
  sx: (v: number) => number,
  sy: (v: number) => number,
  baseline: number,
): string {
  return segments(y)
    .map(([a, b]) => {
      let d = "M" + pt(sx(x[a]), baseline);
      for (let i = a; i <= b; i++) d += "L" + pt(sx(x[i]), sy(y[i]!));
      return d + "L" + pt(sx(x[b]), baseline) + "Z";
    })
    .join("");
}

/** Index of the x closest to `target` (x non-decreasing). */
export function nearestIndex(x: number[], target: number): number {
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= target) lo = mid;
    else hi = mid;
  }
  return Math.abs(x[hi] - target) < Math.abs(x[lo] - target) ? hi : lo;
}


/** The highest altitude sample, metres; undefined without any. */
export function maxAltitude(detail: DetailFile): number | undefined {
  let top: number | undefined;
  for (const v of detail.alt ?? []) if (v != null && (top === undefined || v > top)) top = v;
  return top;
}

/**
 * The charts the map panel draws: all the profile has, but cadence for a hike or a walk,
 * where a step rate of 50–60 with stops says nothing.
 */
export function chartKinds(profile: Profile, type: string): ChartKind[] {
  const kinds = profile.charts.map((c) => c.kind);
  return type === "Hike" || type === "Walk" ? kinds.filter((k) => k !== "cadence") : kinds;
}

