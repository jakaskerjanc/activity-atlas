// Frontend copy of the display-file wire formats produced by scripts/build-tracks.ts.
// Keep in sync with scripts/types.ts. Absent means unknown: optional keys are left
// out, never 0 or null; only detail sample arrays hold null.

/** UI color scheme. Drives both the panel chrome and the Mapbox base style. */
export type Theme = "light" | "dark";

/** One provider record behind an activity, enough to link back to it. */
export interface ActivitySource {
  provider: "strava" | "garmin";
  /** the provider's own activity id */
  id: string;
}

/** Stream channels an activity has, from the database's has_* flags. */
export type Channel = "gps" | "hr" | "altitude" | "cadence" | "power";

/** One activity in activities.json: every number the map or analytics read. */
export interface ActivityRecord {
  /** random activity id (v2), opaque */
  id: string;
  name: string;
  /** activity-type filter key */
  type: string;
  /** epoch SECONDS (UTC) — numeric so Mapbox filter expressions can range-filter by date */
  ts: number;
  /** ISO start (UTC) */
  start_date: string;
  /** local wall-clock start, ISO without offset */
  start_local?: string;
  /** meters */
  distance?: number;
  /** seconds */
  moving_time?: number;
  /** seconds */
  elapsed_time?: number;
  /** meters */
  elevation_gain?: number;
  /** meters */
  elevation_loss?: number;
  /** bpm */
  avg_hr?: number;
  /** bpm */
  max_hr?: number;
  /** seconds below zone 1, then in zones 1–5 */
  hr_zones?: number[];
  channels: Channel[];
  /** Live provider sources only (deleted ones are dropped), Strava first. */
  sources: ActivitySource[];
  /** activity/<id>.json exists */
  detail?: true;
}

/** Root of routes.json: Google polylines (precision 5, simplified) keyed by activity id. */
export interface RoutesFile {
  v: 4;
  routes: Record<string, string>;
}

/** Root of activities.json: every visible activity, sorted by start then id. */
export interface ActivitiesFile {
  v: 1;
  activities: ActivityRecord[];
}

/**
 * Root of profiles.json: each activity's route profile, keyed by activity id. Point i
 * is the elevation at i * `step` metres from the start, in whole metres relative to the
 * start. Activities without distance and altitude samples are left out.
 */
export interface ProfilesFile {
  v: 1;
  /** metres of distance between points */
  step: number;
  profiles: Record<string, number[]>;
}

/** activity/<id>.json: downsampled samples; every array is as long as `t`. */
export interface DetailFile {
  v: 1;
  /** bucket width in seconds */
  step: number;
  /** seconds since start */
  t: number[];
  /** meters from start */
  d?: (number | null)[];
  /** degrees */
  lat?: (number | null)[];
  lon?: (number | null)[];
  /** meters */
  alt?: (number | null)[];
  /** bpm */
  hr?: (number | null)[];
  /** m/s */
  speed?: (number | null)[];
  /** rpm / spm as stored */
  cad?: (number | null)[];
}

/** A map feature carries its activity record as properties. */
export type ActivityFeatureProps = ActivityRecord;

export type ActivityFeature = GeoJSON.Feature<GeoJSON.LineString, ActivityFeatureProps>;

export type ActivityFeatureCollection = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  ActivityFeatureProps
>;
