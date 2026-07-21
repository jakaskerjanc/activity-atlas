// Douglas–Peucker line simplification for [lng, lat] coordinate arrays.
//
// Used at build time to thin the full-resolution detail polyline down to a
// payload-friendly overview line. Endpoints are always preserved. Distances are
// measured in planar degree space; the tolerance is given in meters and
// converted with a flat ~111.32 km/deg factor. The tiny lng/lat anisotropy this
// ignores is negligible at the meter-scale tolerances we use.

const METERS_PER_DEGREE = 111_320;

type LngLat = [number, number];

/** Squared distance from p to segment a–b, clamped to the segment. */
function sqSegDist(p: LngLat, a: LngLat, b: LngLat): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/**
 * Simplify a [lng, lat] polyline with Douglas–Peucker.
 * Returns the input unchanged when it has fewer than 3 points.
 */
export function simplifyLngLat(points: LngLat[], toleranceMeters: number): LngLat[] {
  const n = points.length;
  if (n < 3 || toleranceMeters <= 0) return points;

  const tol = toleranceMeters / METERS_PER_DEGREE; // degrees
  const tolSq = tol * tol;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // Iterative (stack-based) to avoid deep recursion on long tracks.
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxSq = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxSq) {
        maxSq = d;
        idx = i;
      }
    }
    if (maxSq > tolSq && idx !== -1) {
      keep[idx] = 1;
      stack.push([first, idx]);
      stack.push([idx, last]);
    }
  }

  const out: LngLat[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}
