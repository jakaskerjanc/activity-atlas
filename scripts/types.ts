// Shared types for the pipeline and (by contract) the frontend.

/**
 * One route in the compact wire format written to app/public/tracks.json.
 * Carries the filterable feature props plus a Google-encoded polyline
 * (precision 5, simplified) of the route — far smaller than a decoded GeoJSON
 * coordinate array. The frontend decodes these back into LineString features
 * (see app/src/tracks.ts). Keep in sync with the frontend copy in app/src/types.ts.
 */
export interface EncodedTrack extends ActivityFeatureProps {
  /** Google-encoded polyline of the route, [lat,lng] precision-5. */
  poly: string;
}

/** Root shape of app/public/tracks.json. */
export interface TrackPayload {
  /** Wire-format version, bumped on breaking shape changes. */
  v: number;
  tracks: EncodedTrack[];
}

/**
 * GeoJSON feature properties consumed by the frontend map + filters.
 * This is the stable data contract the UI depends on.
 */
export interface ActivityFeatureProps {
  /** Namespaced wire id: "s:<stravaId>" or "g:<garminId>". */
  id: string;
  name: string;
  /** activity-type filter key */
  type: string;
  /** epoch SECONDS — numeric so Mapbox filter expressions can range-filter by date */
  ts: number;
  /** ISO start date, for display */
  start_date: string;
  /** meters */
  distance: number;
  /** seconds */
  moving_time: number;
  /** meters */
  elevation_gain: number;
}
