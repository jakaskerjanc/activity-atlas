// The elevation heatmap on the Analytics page (#16): every visible activity's route
// profile (elevation relative to its start, against distance in km) drawn into one grid,
// each cell counting how many profiles pass through it. A climb you repeat lands in the
// same cells every time and burns bright; one-off outings stay faint. Pure module, no
// React; ui/ElevationHeatmap.tsx paints the grid.

import { quantile } from "./stats";

/** The longest and highest profiles are cut off at these quantiles, so one century ride
 * or alpine day doesn't squeeze everything else into a corner. */
const X_QUANTILE = 0.95;
const Y_QUANTILE = 0.95;

export interface HeatmapGrid {
  cols: number;
  rows: number;
  /** counts[row * cols + col]: profiles passing through the cell. Row 0 is the top. */
  counts: number[];
  /** The largest count. */
  max: number;
  /** Distance shown, in metres from the start (the left edge is 0). */
  xMaxM: number;
  /** Elevation shown, in metres relative to the start: bottom and top edges. */
  yMin: number;
  yMax: number;
  /** Profiles drawn. */
  profiles: number;
  /** Of those, how many run past the right edge or above or below the chart. */
  cut: number;
}

/** Up to the next multiple of `step` (and at least one step). */
const ceilTo = (v: number, step: number) => Math.max(step, Math.ceil(v / step) * step);
const floorTo = (v: number, step: number) => Math.min(0, Math.floor(v / step) * step);

/**
 * Bin route profiles (elevation every `step` metres, relative to the start) into a
 * cols x rows density grid. Null without profiles.
 */
export function heatmapGrid(
  profiles: readonly (readonly number[])[],
  step: number,
  cols = 180,
  rows = 90,
): HeatmapGrid | null {
  if (profiles.length === 0) return null;
  const lengths = profiles.map((p) => (p.length - 1) * step);
  // Whole km, or whole 5 km once the axis is past 10 km.
  const longest = quantile(lengths, X_QUANTILE);
  const xMaxM = ceilTo(longest, longest > 10_000 ? 5000 : 1000);
  const yMax = ceilTo(quantile(profiles.map((p) => Math.max(...p)), Y_QUANTILE), 10);
  const yMin = floorTo(quantile(profiles.map((p) => Math.min(...p)), 1 - Y_QUANTILE), 10);

  const counts = new Array<number>(cols * rows).fill(0);
  // The bottom edge itself belongs to the last row, not the one below the chart.
  const rowOf = (y: number) =>
    y === yMin ? rows - 1 : Math.floor(((yMax - y) / (yMax - yMin)) * rows);
  let cut = 0;
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    if (lengths[i] > xMaxM || Math.max(...p) > yMax || Math.min(...p) < yMin) cut++;
    let prev: number | null = null;
    for (let c = 0; c < cols; c++) {
      // Elevation at the column's centre, interpolated between the profile's points.
      const at = (((c + 0.5) / cols) * xMaxM) / step;
      if (at > p.length - 1) break;
      const k = Math.min(Math.floor(at), p.length - 2);
      const row = rowOf(p[k] + (p[k + 1] - p[k]) * (at - k));
      // Fill the column from the previous column's row to this one, so a steep climb
      // reads as a connected line rather than scattered dots.
      const from = Math.max(0, Math.min(prev ?? row, row));
      const to = Math.min(rows - 1, Math.max(prev ?? row, row));
      for (let r = from; r <= to; r++) counts[r * cols + c] += 1;
      prev = row;
    }
  }
  return {
    cols,
    rows,
    counts,
    max: Math.max(0, ...counts),
    xMaxM,
    yMin,
    yMax,
    profiles: profiles.length,
    cut,
  };
}

/**
 * A cell's opacity for its count: a log scale, since a few repeated routes pile up far
 * more than everything else, and a linear scale would leave the rest invisible. Empty
 * cells are transparent; a single pass is faint but visible.
 */
export function cellAlpha(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const MIN = 0.14;
  return MIN + (1 - MIN) * (Math.log1p(count - 1) / Math.log1p(Math.max(1, max - 1)) || 0);
}
