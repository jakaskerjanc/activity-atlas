import { describe, expect, test } from "vitest";
import {
  buildTimeline,
  frameAt,
  totalDurationMs,
  PER_ACTIVITY_MS,
  MIN_TOTAL_MS,
  MAX_TOTAL_MS,
} from "./replay";
import type { ActivityFeature, ActivityFeatureProps } from "./types";

function feature(props: Partial<ActivityFeatureProps>): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [] },
    properties: {
      id: 1,
      name: "Test",
      type: "Run",
      ts: 1000,
      start_date: "2024-08-18T09:58:55Z",
      distance: 10000,
      moving_time: 3000,
      elevation_gain: 100,
      ...props,
    },
  };
}

describe("totalDurationMs", () => {
  test("scales with count between the clamps", () => {
    const n = Math.round((MIN_TOTAL_MS + MAX_TOTAL_MS) / 2 / PER_ACTIVITY_MS);
    expect(totalDurationMs(n)).toBe(n * PER_ACTIVITY_MS);
  });
  test("clamps small and large sets, and zero for empty", () => {
    expect(totalDurationMs(1)).toBe(MIN_TOTAL_MS);
    expect(totalDurationMs(100000)).toBe(MAX_TOTAL_MS);
    expect(totalDurationMs(0)).toBe(0);
  });
});

describe("buildTimeline", () => {
  test("orders by ts, then id as tiebreak", () => {
    const steps = buildTimeline([
      feature({ id: 3, ts: 300 }),
      feature({ id: 1, ts: 100 }),
      feature({ id: 5, ts: 100 }),
      feature({ id: 2, ts: 200 }),
    ]);
    expect(steps).toEqual([
      { id: 1, ts: 100 },
      { id: 5, ts: 100 },
      { id: 2, ts: 200 },
      { id: 3, ts: 300 },
    ]);
  });
});

describe("frameAt", () => {
  const timeline = buildTimeline([
    feature({ id: 1, ts: 100 }),
    feature({ id: 2, ts: 200 }),
    feature({ id: 3, ts: 300 }),
    feature({ id: 4, ts: 400 }),
  ]);

  test("empty timeline resolves to null", () => {
    expect(frameAt([], 0.5)).toBeNull();
  });

  test("g=0 starts the first route un-drawn", () => {
    expect(frameAt(timeline, 0)).toEqual({ index: 0, id: 1, ts: 100, trim: 0 });
  });

  test("mid-slice yields the fractional trim within the active route", () => {
    // 4 routes → each slice is 0.25 wide; g=0.375 is halfway through route index 1.
    expect(frameAt(timeline, 0.375)).toEqual({ index: 1, id: 2, ts: 200, trim: 0.5 });
  });

  test("g>=1 draws the last route fully", () => {
    expect(frameAt(timeline, 1)).toEqual({ index: 3, id: 4, ts: 400, trim: 1 });
    expect(frameAt(timeline, 2)).toEqual({ index: 3, id: 4, ts: 400, trim: 1 });
  });

  test("clamps negative progress to the start", () => {
    expect(frameAt(timeline, -1)).toEqual({ index: 0, id: 1, ts: 100, trim: 0 });
  });
});
