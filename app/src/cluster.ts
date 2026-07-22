// Pick the bounding box of the densest cluster of activities, so far-flung trips
// (a race abroad, a holiday) don't blow out the replay camera and shrink the home
// region to a dot. Pure module (no React / Mapbox) — MapView turns the box into a
// LngLatBounds. Tested in cluster.test.ts.

import type { ActivityFeature } from "./types";

/** [west, south, east, north] in lng/lat. */
export type Bounds = [number, number, number, number];

/** Mean [lng, lat] of a route — one representative point per activity, so a single
 *  long route doesn't outvote many short ones when finding where activity concentrates. */
function centroid(f: ActivityFeature): [number, number] {
  const cs = f.geometry.coordinates;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of cs) {
    sx += x;
    sy += y;
  }
  const n = cs.length || 1;
  return [sx / n, sy / n];
}

/** Union bounds of the given routes' full geometry, or null if empty. */
function boundsOf(features: ActivityFeature[]): Bounds | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const f of features) {
    for (const [x, y] of f.geometry.coordinates) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return e < w ? null : [w, s, e, n];
}

/** Bounds of a set of points, or null if empty or all points coincide (zero area). */
function boundsOfPoints(points: [number, number][]): Bounds | null {
  if (points.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return w === e && s === n ? null : [w, s, e, n];
}

/**
 * Indices of the points falling in the densest grid cell plus its eight neighbours
 * (so a cluster straddling a cell boundary stays whole). Returns every index when the
 * points share a single location (nothing to separate).
 */
function densestNeighborhood(points: [number, number][], gridN: number): number[] {
  const all = points.map((_, i) => i);
  if (points.length === 0) return all;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === maxX && minY === maxY) return all;

  const cellW = (maxX - minX) / gridN || 1;
  const cellH = (maxY - minY) / gridN || 1;
  const cells = points.map(
    ([x, y]) =>
      [
        Math.min(gridN - 1, Math.floor((x - minX) / cellW)),
        Math.min(gridN - 1, Math.floor((y - minY) / cellH)),
      ] as [number, number],
  );

  const counts = new Map<string, number>();
  let bestN = -1;
  let bestCell: [number, number] = [0, 0];
  for (const [a, b] of cells) {
    const c = (counts.get(`${a},${b}`) ?? 0) + 1;
    counts.set(`${a},${b}`, c);
    if (c > bestN) {
      bestN = c;
      bestCell = [a, b];
    }
  }

  return all.filter(
    (i) =>
      Math.abs(cells[i][0] - bestCell[0]) <= 1 &&
      Math.abs(cells[i][1] - bestCell[1]) <= 1,
  );
}

/**
 * Bounds of the densest cluster, framed on where its activities are *centred* (not the
 * full sprawl of every route that starts there) for a tight home-base view.
 *
 * A single grid pass is coarse: a far-flung trip inflates the extent so cells span
 * hundreds of km and an entire home country collapses into one "densest" cell. So we
 * refine — re-grid over the surviving cluster each pass, zooming from continent → country
 * → home region — stopping when the cluster stops shrinking (converged) or would drop
 * below `minFraction` of the activities (don't over-zoom onto a single trailhead).
 *
 * Falls back to the cluster's full geometry when the centres coincide, then to everything.
 */
export function densestClusterBounds(
  features: ActivityFeature[],
  gridN = 8,
  minFraction = 0.15,
): Bounds | null {
  if (features.length === 0) return null;

  const pts = features.map(centroid);
  const floor = Math.max(5, Math.ceil(features.length * minFraction));

  let pool = pts.map((_, i) => i);
  for (let iter = 0; iter < 6; iter++) {
    const local = densestNeighborhood(
      pool.map((i) => pts[i]),
      gridN,
    );
    if (local.length === pool.length) break; // converged — already concentrated
    if (local.length < floor) break; // refining further would over-zoom
    pool = local.map((k) => pool[k]);
  }

  return (
    boundsOfPoints(pool.map((i) => pts[i])) ??
    boundsOf(pool.map((i) => features[i])) ??
    boundsOf(features)
  );
}
