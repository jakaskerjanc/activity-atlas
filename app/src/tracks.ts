// Join routes.json and activities.json into the GeoJSON FeatureCollection the map +
// panels consume. Routes ship as Google-encoded polylines keyed by activity id; we
// expand them here. Only activities with a route become features: the map has no
// line to draw or click for the rest (they stay in activities.json for analytics).
// Keep in sync with scripts/build-tracks.ts (the encoder side).

import polyline from "@mapbox/polyline";
import type {
  ActivitiesFile,
  ActivityFeature,
  ActivityFeatureCollection,
  ActivityRecord,
  RoutesFile,
} from "./types";

/** Wire-format versions this app understands (see scripts/build-tracks.ts). */
export const ROUTES_VERSION = 4;
export const ACTIVITIES_VERSION = 1;

function toFeature(record: ActivityRecord, poly: string): ActivityFeature | null {
  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  const coordinates = polyline.decode(poly).map(([lat, lng]) => [lng, lat] as [number, number]);
  // A LineString needs >= 2 points. The builder guarantees this, but a corrupt or
  // truncated payload shouldn't reach the map as a degenerate geometry.
  if (coordinates.length < 2) return null;
  return { type: "Feature", geometry: { type: "LineString", coordinates }, properties: record };
}

/** Activities with a route, in activities.json order, as map features. */
export function joinActivities(
  routes: RoutesFile,
  activities: ActivitiesFile,
): ActivityFeatureCollection {
  if (routes.v !== ROUTES_VERSION) {
    throw new Error(`Unsupported routes version ${routes.v} (expected ${ROUTES_VERSION})`);
  }
  if (activities.v !== ACTIVITIES_VERSION) {
    throw new Error(`Unsupported activities version ${activities.v} (expected ${ACTIVITIES_VERSION})`);
  }
  const features: ActivityFeature[] = [];
  for (const record of activities.activities) {
    const poly = routes.routes[record.id];
    const f = poly ? toFeature(record, poly) : null;
    if (f) features.push(f);
  }
  return { type: "FeatureCollection", features };
}
