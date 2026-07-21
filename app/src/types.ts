// Frontend copy of the GeoJSON data contract produced by the pipeline.
// Keep in sync with scripts/types.ts (ActivityFeatureProps).

export interface ActivityFeatureProps {
  id: number;
  name: string;
  /** activity-type filter key (Strava sport_type) */
  type: string;
  /** epoch seconds — used for numeric date-range filtering */
  ts: number;
  start_date: string;
  /** meters */
  distance: number;
  /** seconds */
  moving_time: number;
  /** meters */
  elevation_gain: number;
}

export type ActivityFeature = GeoJSON.Feature<
  GeoJSON.LineString,
  ActivityFeatureProps
>;

export type ActivityFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  ActivityFeatureProps
>;

/**
 * Compact wire format fetched from app/public/tracks.json and decoded in the
 * browser (see tracks.ts). Each track is the filterable props plus a
 * Google-encoded polyline of the route — ~2x smaller than decoded GeoJSON
 * coordinate arrays. Keep in sync with scripts/types.ts (the encoder side).
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
