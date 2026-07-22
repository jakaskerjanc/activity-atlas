// Pure timeline math for the chronological replay (routes draw on in date order,
// accumulating on the map). No React / Mapbox deps — like filters.ts / colors.ts,
// the imperative map work lives in MapView; this module only maps a single global
// progress value g ∈ [0,1] onto "which route is drawing, and how far".
//
// Model: equal time per activity. With N routes the timeline is split into N equal
// slices; slice i draws route i from its start (trim 0) to its end (trim 1). Routes
// before i are already complete (shown by the base layers), routes after i are hidden.

import type { ActivityFeature } from "./types";

/** One step of the replay: enough to drive the map filters + the date readout. */
export interface ReplayStep {
  /** feature id — selects the single route the active layers draw. */
  id: number;
  /** epoch seconds — boundary for "completed" routes and the running date label. */
  ts: number;
}

/** The resolved state at a given global progress: which route, how far, what date. */
export interface ReplayFrame {
  /** index into the timeline of the route currently drawing. */
  index: number;
  /** id of the route currently drawing (active layers filter on this). */
  id: number;
  /** epoch seconds of the drawing route — completed set is everything before this. */
  ts: number;
  /** 0..1 fraction of the active route drawn so far (line-trim reveal). */
  trim: number;
}

// Pace tuning. Each activity gets an equal share of the run; the total is clamped so
// large histories stay watchable and tiny sets aren't over in a blink.
export const PER_ACTIVITY_MS = 55;
export const MIN_TOTAL_MS = 6000;
export const MAX_TOTAL_MS = 45000;

/** Base wall-clock duration (at 1×) for a replay of `count` routes, clamped. */
export function totalDurationMs(count: number): number {
  if (count <= 0) return 0;
  return Math.min(MAX_TOTAL_MS, Math.max(MIN_TOTAL_MS, count * PER_ACTIVITY_MS));
}

/** Chronological step list for the given (already filtered) features, ascending by ts. */
export function buildTimeline(features: ActivityFeature[]): ReplayStep[] {
  return features
    .map((f) => ({ id: f.properties.id, ts: f.properties.ts }))
    // ts primary, id as a stable tiebreak so equal-second starts keep a fixed order.
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
}

/**
 * Resolve the frame at global progress `g` (0 = start, 1 = fully drawn). Returns null
 * for an empty timeline. At g >= 1 the last route is fully drawn (trim 1); otherwise
 * `g * N` splits into an integer route index and the fractional trim within it.
 */
export function frameAt(timeline: ReplayStep[], g: number): ReplayFrame | null {
  const n = timeline.length;
  if (n === 0) return null;
  if (g >= 1) {
    const last = timeline[n - 1];
    return { index: n - 1, id: last.id, ts: last.ts, trim: 1 };
  }
  const pos = Math.max(0, g) * n;
  const index = Math.min(n - 1, Math.floor(pos));
  const trim = Math.min(1, Math.max(0, pos - index));
  const step = timeline[index];
  return { index, id: step.id, ts: step.ts, trim };
}
