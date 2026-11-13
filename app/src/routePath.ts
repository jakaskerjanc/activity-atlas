// A route as an SVG path: the one way the site draws a route outside Mapbox. The map's
// stand-in picture (ui/RoutePreview.tsx) draws every route with it through the map's
// opening camera, and the Activities page's preview (trackSketch.ts) one route fitted to
// its box. Pure module.

/** Screen position of a [lng, lat] point, in px. */
export type Projector = (lng: number, lat: number) => [number, number];

export interface RoutePath {
  /** SVG path data, in px. */
  d: string;
  start: [number, number];
  end: [number, number];
}

/** How a drawn route looks: a wide faint glow under a thin line, both in the accent. */
export const ROUTE_GLOW = { width: 6, opacity: 0.2 } as const;
export const ROUTE_LINE = { width: 2.6, opacity: 0.85 } as const;

/**
 * `coords` ([lng, lat]) through `project`, dropping points closer than `minStep` px to
 * the last kept one (detail the line hides, and every point costs parse and stroke
 * time) but always keeping the last, so a route ends where it ends. Null for fewer than
 * two points.
 */
export function routePath(
  coords: readonly (readonly number[])[],
  project: Projector,
  minStep: number,
): RoutePath | null {
  if (coords.length < 2) return null;
  const minStep2 = minStep * minStep;
  const start = project(coords[0][0], coords[0][1]);
  let [lx, ly] = start;
  let d = `M${lx.toFixed(1)} ${ly.toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const [x, y] = project(coords[i][0], coords[i][1]);
    const last = i === coords.length - 1;
    if (!last && (x - lx) ** 2 + (y - ly) ** 2 < minStep2) continue;
    d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
    lx = x;
    ly = y;
  }
  return { d, start, end: [lx, ly] };
}
