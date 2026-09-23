// Shared test fixtures. Not imported by app code.

import type { ActivityFeature, ActivityFeatureProps } from "./types";

/** A minimal activity with plausible defaults; override just the properties a test cares about. */
export function activity(props: Partial<ActivityFeatureProps> = {}): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [] },
    properties: {
      id: "s:1",
      name: "Test",
      type: "Run",
      ts: 1723975135,
      start_date: "2024-08-18T09:58:55Z",
      distance: 10000,
      moving_time: 3000,
      elevation_gain: 100,
      ...props,
    },
  };
}
