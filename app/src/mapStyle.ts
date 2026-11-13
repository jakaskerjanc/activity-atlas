// The basemap: Mapbox token and style per theme, shared by the live map (MapView) and
// the still map images of the Activities page's previews (Static Images API), so both
// show the same map. Kept out of MapView so a still image never pulls in mapbox-gl.

import type { Camera } from "./homeCamera";
import type { Theme } from "./types";

export const MAPBOX_TOKEN: string | undefined = import.meta.env.VITE_MAPBOX_TOKEN || undefined;

/**
 * Without a token mapboxgl.Map throws on construction and takes the whole app down with
 * it, and still images can't load. Skip the map instead, so the panels and Analytics
 * still work (e.g. a fresh fork showing the demo data).
 */
export const HAS_TOKEN = MAPBOX_TOKEN !== undefined;

/** Base map that reads well under each theme's panels. Light uses the toned streets
 * style (roads/parks/water) so the translucent liquid-glass panels have real color
 * to refract; dark stays the muted dark base. */
export const STYLE_URL: Record<Theme, string> = {
  dark: "mapbox://styles/mapbox/dark-v11",
  light: "mapbox://styles/jkyy/cmrxclplz00ji01qk9apa184q",
};

/**
 * The styles of still map images, per theme. Dark is the live map's own. The live light
 * style is built on Mapbox Standard, which the Static Images API doesn't render (it
 * returns an empty image), so light stills use classic light-v11: the quiet counterpart
 * of dark-v11, under which the accent route reads as clearly as on the dark map.
 */
export const STATIC_STYLE_URL: Record<Theme, string> = {
  dark: STYLE_URL.dark,
  light: "mapbox://styles/mapbox/light-v11",
};

/**
 * A still image of `style` (a mapbox://styles/<owner>/<id> URL) at exactly `camera`,
 * `width` x `height` CSS px at 2x density, from the Static Images API. Its 512 px tiles
 * are the ones homeCamera's projector measures in, so a route projected with the same
 * camera lands on the image's roads. The Mapbox logo and the text attribution are left
 * off the image, by the owner's choice (Mapbox's terms ask for both); the live map
 * keeps its own.
 */
export function staticMapUrl(style: string, camera: Camera, width: number, height: number, token: string): string {
  const path = style.replace(/^mapbox:\/\/styles\//, "");
  const [lng, lat] = camera.center;
  const at = `${lng.toFixed(6)},${lat.toFixed(6)},${camera.zoom.toFixed(2)}`;
  return `https://api.mapbox.com/styles/v1/${path}/static/${at}/${Math.round(width)}x${Math.round(height)}@2x?logo=false&attribution=false&access_token=${encodeURIComponent(token)}`;
}
