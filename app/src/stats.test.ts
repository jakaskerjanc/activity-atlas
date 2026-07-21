import { describe, expect, test } from "vitest";
import { aggregate, totalCards, activityCards } from "./stats";
import type { ActivityFeature, ActivityFeatureProps } from "./types";

function feature(props: Partial<ActivityFeatureProps>): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [] },
    properties: {
      id: 1,
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

describe("aggregate", () => {
  test("sums distance, elevation, moving time and counts features", () => {
    const agg = aggregate([
      feature({ distance: 10000, elevation_gain: 100, moving_time: 3000 }),
      feature({ distance: 5000, elevation_gain: 50, moving_time: 1800 }),
    ]);
    expect(agg).toEqual({
      count: 2,
      totalDistanceM: 15000,
      totalElevationM: 150,
      totalMovingSec: 4800,
    });
  });

  test("empty collection is all zeros", () => {
    expect(aggregate([])).toEqual({
      count: 0,
      totalDistanceM: 0,
      totalElevationM: 0,
      totalMovingSec: 0,
    });
  });
});

describe("totalCards", () => {
  test("produces Activities / Total km / Elevation / Moving cards", () => {
    const cards = totalCards([
      feature({ distance: 10000, elevation_gain: 100, moving_time: 3000 }),
      feature({ distance: 5000, elevation_gain: 50, moving_time: 1800 }),
    ]);
    expect(cards).toEqual([
      { value: "2", label: "Activities" },
      { value: "15", label: "Total km", accent: true },
      { value: "150", label: "Elevation m" },
      { value: "1h 20m", label: "Moving" },
    ]);
  });
});

describe("activityCards", () => {
  test("foot-based activity shows pace per km", () => {
    const cards = activityCards(
      feature({ type: "Run", distance: 10000, moving_time: 3000, elevation_gain: 76 }),
    );
    expect(cards).toEqual([
      { value: "10.0", label: "Distance km", accent: true },
      { value: "50m", label: "Moving" },
      { value: "76", label: "Elevation m" },
      { value: "5:00", label: "Pace /km" },
    ]);
  });

  test("wheel-based activity shows speed km/h", () => {
    const cards = activityCards(
      feature({ type: "Ride", distance: 30000, moving_time: 3600, elevation_gain: 400 }),
    );
    expect(cards[3]).toEqual({ value: "30.0", label: "Speed km/h" });
  });
});
