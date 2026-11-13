// A route drawn small: the Activities page's preview of one activity's track, fitted
// into a box. Pure module. Framed with the map's own camera math (homeCamera.ts) and
// drawn with the same routePath as the map's stand-in picture, so the route lands
// exactly on a still map image taken with that camera (mapStyle.ts: staticMapUrl), and
// matches what "Show on map" then shows.

import { fitCamera, projector, type Camera } from "./homeCamera";
import { routePath, type RoutePath } from "./routePath";

export interface TrackSketch extends RoutePath {
  /** The camera the route was projected with: take the basemap image with it. */
  camera: Camera;
}

/** The closest a preview zooms in, so a short loop doesn't fill the box with one street. */
export const SKETCH_MAX_ZOOM = 16;

/**
 * Fit `coords` ([lng, lat]) inside a `width` x `height` box with `pad` px on every side,
 * centered, north up. Points closer than `minStep` px are dropped (see routePath). Null
 * for fewer than two points.
 */
export function trackSketch(
  coords: readonly (readonly number[])[],
  width: number,
  height: number,
  pad = 12,
  minStep = 1,
): TrackSketch | null {
  if (coords.length < 2) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of coords) {
    w = Math.min(w, lng);
    e = Math.max(e, lng);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  const camera = fitCamera([w, s, e, n], width, height, { top: pad, right: pad, bottom: pad, left: pad }, SKETCH_MAX_ZOOM);
  if (!camera) return null;
  const path = routePath(coords, projector(camera, width, height), minStep);
  return path && { ...path, camera };
}
