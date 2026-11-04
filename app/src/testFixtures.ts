// Shared test fixtures. Not imported by app code.

import type { ActivityFeature, ActivityRecord } from "./types";

/** A minimal activities.json record with plausible defaults; override what a test cares about. */
export function record(props: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id: "s:1",
    name: "Test",
    type: "Run",
    ts: 1723975135,
    start_date: "2024-08-18T09:58:55Z",
    distance: 10000,
    moving_time: 3000,
    elevation_gain: 100,
    channels: [],
    sources: [],
    ...props,
  };
}

/** The same record as a map feature (an activity with a route). */
export function activity(props: Partial<ActivityRecord> = {}): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [] },
    properties: record(props),
  };
}
