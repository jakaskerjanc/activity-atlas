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
