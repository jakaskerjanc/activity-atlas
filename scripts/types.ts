// Shared types for the pipeline and (by contract) the frontend.

/** Trimmed Strava activity summary we persist in data/activities.json. */
export interface CachedActivity {
  id: number;
  name: string;
  /** Strava sport_type (falls back to type), e.g. "Run", "Ride", "Hike". */
  type: string;
  /** ISO 8601 start time (UTC), e.g. "2026-07-21T06:30:00Z". */
  start_date: string;
  /** meters */
  distance: number;
  /** seconds */
  moving_time: number;
  /** meters */
  total_elevation_gain: number;
  /** Google encoded polyline of the route overview; "" for indoor/manual. */
  summary_polyline: string;
  /**
   * Full-resolution encoded polyline from the activity detail endpoint.
   * Absent until backfilled; preferred over summary_polyline when present.
   */
  detail_polyline?: string;
}

/**
 * GeoJSON feature properties consumed by the frontend map + filters.
 * This is the stable data contract the UI depends on.
 */
export interface ActivityFeatureProps {
  id: number;
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
