// Map side of the chart/map cursor (#17): where the cursor sample sits on the map,
// and which sample is nearest the pointer over the selected route. Pure.

import type { DetailFile } from "./types";

/** [lng, lat] of sample `i`, or null without a cursor or a position there. */
export function cursorLngLat(detail: DetailFile, i: number | null): [number, number] | null {
  if (i == null) return null;
  const lat = detail.lat?.[i];
  const lon = detail.lon?.[i];
  return lat == null || lon == null ? null : [lon, lat];
}

/**
 * Index of the sample nearest (lng, lat), by equirectangular distance (longitude
 * scaled by cos(latitude)); samples without a position are skipped. Null without GPS.
 */
export function nearestSample(detail: DetailFile, lng: number, lat: number): number | null {
  const { lat: lats, lon: lons } = detail;
  if (!lats || !lons) return null;
  const k = Math.cos((lat * Math.PI) / 180);
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < lats.length; i++) {
    const a = lats[i];
    const b = lons[i];
    if (a == null || b == null) continue;
    const dx = (b - lng) * k;
    const dy = a - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Where the map marker goes: the cursor's position, but only while the selected
 * route is drawn. A filtered-out route keeps its charts but gets no marker (#17).
 */
export function markerPoint(
  detail: DetailFile | null,
  i: number | null,
  routeShown: boolean,
): [number, number] | null {
  return detail && routeShown ? cursorLngLat(detail, i) : null;
}
