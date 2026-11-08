// The opening map camera, computed without Mapbox. The route preview (ui/RoutePreview)
// draws the routes where the map will draw them before mapbox-gl has loaded, and MapView
// starts on the same camera, so the map's first tiles are the ones it will keep. Pure
// module (no React / Mapbox); tested in homeCamera.test.ts.
//
// The math is Mapbox's flat Web Mercator: a 512 px world at zoom 0, doubling per zoom
// level. At the zooms the opening view uses, the globe projection has fully given way to
// it, so the preview and the map agree to within a pixel or two.

import { densestClusterRouteBounds, type Bounds } from "./cluster";
import { fitOffset, fitPadding, type FitPadding, type Insets } from "./ui/layout";
import type { ActivityFeature } from "./types";

/** Mapbox's world size in px at zoom 0. */
const TILE_SIZE = 512;
/** The opening view's closest zoom, so a single short route doesn't open at street level. */
export const HOME_MAX_ZOOM = 13;

export interface Camera {
  /** [lng, lat] at the middle of the canvas. */
  center: [number, number];
  zoom: number;
}

/** Longitude to Mercator x, 0..1 west to east. */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude to Mercator y, 0..1 north to south. */
export function mercatorY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function lngOf(x: number): number {
  return x * 360 - 180;
}

function latOf(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * The camera that fits `box` into the canvas minus `padding`, centered in the padded
 * area, as MapView's cameraFor asks Mapbox for it (padding for the zoom, fitOffset for
 * the center). Null when the padding leaves no room.
 */
export function fitCamera(
  box: Bounds,
  width: number,
  height: number,
  padding: FitPadding,
  maxZoom: number,
): Camera | null {
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;
  if (w <= 0 || h <= 0) return null;
  const x0 = mercatorX(box[0]);
  const x1 = mercatorX(box[2]);
  const y0 = mercatorY(box[3]); // north edge: the smaller y
  const y1 = mercatorY(box[1]);
  // A box with no extent on an axis (one point) doesn't constrain that axis.
  const sx = x1 > x0 ? w / ((x1 - x0) * TILE_SIZE) : Infinity;
  const sy = y1 > y0 ? h / ((y1 - y0) * TILE_SIZE) : Infinity;
  const zoom = Math.min(maxZoom, Math.log2(Math.min(sx, sy)));
  const world = TILE_SIZE * 2 ** zoom;
  // The box's middle lands at the canvas center plus the offset, so the canvas center
  // sits the offset's distance back from it.
  const [ox, oy] = fitOffset(padding);
  const cx = (x0 + x1) / 2 - ox / world;
  const cy = (y0 + y1) / 2 - oy / world;
  return { center: [lngOf(cx), latOf(cy)], zoom };
}

/**
 * The opening view: the densest cluster's routes fitted into the area the panels leave
 * free, as MapView's frameHome frames it once the map loads. Null with no routes or no
 * room.
 */
export function homeCamera(
  features: ActivityFeature[],
  width: number,
  height: number,
  insets: Insets,
): Camera | null {
  const box = densestClusterRouteBounds(features);
  if (!box) return null;
  return fitCamera(box, width, height, fitPadding(width, height, insets), HOME_MAX_ZOOM);
}

/** Screen position, in px from the canvas's top left, of [lng, lat] under `camera`. */
export function projector(
  camera: Camera,
  width: number,
  height: number,
): (lng: number, lat: number) => [number, number] {
  const world = TILE_SIZE * 2 ** camera.zoom;
  const cx = mercatorX(camera.center[0]);
  const cy = mercatorY(camera.center[1]);
  return (lng, lat) => [
    (mercatorX(lng) - cx) * world + width / 2,
    (mercatorY(lat) - cy) * world + height / 2,
  ];
}
