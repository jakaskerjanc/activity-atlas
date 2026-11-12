import { describe, expect, test } from "vitest";
import { aggregate, totalCards, activityCards } from "./stats";
import type { ActivityFeature, ActivityFeatureProps } from "./types";

function feature(props: Partial<ActivityFeatureProps>): ActivityFeature {
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
      channels: [],
      sources: [],
      ...props,
    },
  };
}

/** The record alone: totals read activities.json records, with or without a route. */
const rec = (props: Partial<ActivityFeatureProps>) => feature(props).properties;

describe("aggregate", () => {
  test("sums distance, elevation, moving time and counts features", () => {
    const agg = aggregate([
      rec({ distance: 10000, elevation_gain: 100, moving_time: 3000 }),
      rec({ distance: 5000, elevation_gain: 50, moving_time: 1800 }),
    ]);
    expect(agg).toEqual({
      count: 2,
      distance: { sum: 15000, n: 2 },
      elevation: { sum: 150, n: 2 },
      moving: { sum: 4800, n: 2 },
    });
  });

  test("empty collection is all zeros", () => {
    expect(aggregate([])).toEqual({
      count: 0,
      distance: { sum: 0, n: 0 },
      elevation: { sum: 0, n: 0 },
      moving: { sum: 0, n: 0 },
    });
  });
});

describe("coverage", () => {
  test("aggregate counts coverage per value", () => {
    const agg = aggregate([
      rec({ elevation_gain: 100 }),
      rec({ elevation_gain: undefined }),
      rec({ elevation_gain: 50 }),
    ]);
    expect(agg.count).toBe(3);
    expect(agg.elevation).toEqual({ sum: 150, n: 2 });
  });

  test("totalCards sums partial coverage without a note", () => {
    const cards = totalCards([
      rec({ elevation_gain: 100 }),
      rec({ elevation_gain: undefined }),
      rec({ elevation_gain: 50 }),
    ]);
    expect(cards[2]).toEqual({ value: "150", unit: "m", label: "Elevation gain" });
  });

  test("totalCards dashes a value nobody has", () => {
    const cards = totalCards([rec({ distance: undefined }), rec({ distance: undefined })]);
    expect(cards[1]).toEqual({ value: "—", unit: "km", label: "Distance", accent: true });
  });

  test("activityCards dashes missing values", () => {
    const cards = activityCards(feature({ distance: undefined, elevation_gain: undefined }));
    expect(cards[0].value).toBe("—");
    expect(cards[2].value).toBe("—");
    expect(cards[3]).toEqual({ value: "—", unit: "/km", label: "Pace" });
  });
});

describe("totalCards", () => {
  test("produces Activities / Distance / Elevation gain / Moving time cards", () => {
    const cards = totalCards([
      rec({ distance: 10000, elevation_gain: 100, moving_time: 3000 }),
      rec({ distance: 5000, elevation_gain: 50, moving_time: 1800 }),
    ]);
    expect(cards).toEqual([
      { value: "2", label: "Activities" },
      { value: "15", unit: "km", label: "Distance", accent: true },
      { value: "150", unit: "m", label: "Elevation gain" },
      {
        value: "1h 20m",
        parts: [
          { value: "1", unit: "h" },
          { value: "20", unit: "m" },
        ],
        label: "Moving time",
      },
    ]);
  });
});

describe("activityCards", () => {
  test("foot-based activity shows pace per km", () => {
    const cards = activityCards(
      feature({ type: "Run", distance: 10000, moving_time: 3000, elevation_gain: 76 }),
    );
    expect(cards).toEqual([
      { value: "10.0", unit: "km", label: "Distance", accent: true },
      { value: "50m", parts: [{ value: "50", unit: "m" }], label: "Moving time" },
      { value: "76", unit: "m", label: "Elevation gain" },
      { value: "5:00", unit: "/km", label: "Pace" },
    ]);
  });

  test("wheel-based activity shows speed km/h", () => {
    const cards = activityCards(
      feature({ type: "Ride", distance: 30000, moving_time: 3600, elevation_gain: 400 }),
    );
    expect(cards[3]).toEqual({ value: "30.0", unit: "km/h", label: "Speed" });
  });
});
