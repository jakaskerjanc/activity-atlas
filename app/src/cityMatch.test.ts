import { describe, expect, test } from "vitest";
import { activityGroup, groupTotals, seededRng } from "./cityMatch";
import type { ActivityFeature } from "./types";

function feature(type: string, distance: number): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[14.5, 46], [14.6, 46.1]] },
    properties: {
      id: `s:${type}${distance}`, name: type, type, ts: 0, start_date: "",
      distance, moving_time: 0, elevation_gain: 0,
    },
  };
}

describe("activityGroup", () => {
  test.each(["Ride", "EBikeRide", "GravelRide", "MountainBikeRide"])("%s → cycling", (t) => {
    expect(activityGroup(t)).toBe("cycling");
  });
  test.each(["Run", "TrailRun", "Walk", "Hike"])("%s → walking", (t) => {
    expect(activityGroup(t)).toBe("walking");
  });
  test.each(["VirtualRide", "VirtualRun", "Workout", "Swim"])("%s → null", (t) => {
    expect(activityGroup(t)).toBeNull();
  });
});

describe("groupTotals", () => {
  test("sums meters per group and ignores excluded types", () => {
    const totals = groupTotals([
      feature("Ride", 40_000),
      feature("GravelRide", 10_000),
      feature("Run", 8_000),
      feature("Hike", 12_000),
      feature("VirtualRide", 30_000),
      feature("Swim", 2_000),
    ]);
    expect(totals).toEqual({ cycling: 50_000, walking: 20_000 });
  });

  test("empty input → zeros", () => {
    expect(groupTotals([])).toEqual({ cycling: 0, walking: 0 });
  });
});

describe("seededRng", () => {
  const take = (rng: () => number, n = 5) => Array.from({ length: n }, rng);

  test("same profile + km gives the same sequence in [0, 1)", () => {
    const a = take(seededRng("cycling", 2_500_400));
    const b = take(seededRng("cycling", 2_500_100)); // same km after rounding
    expect(a).toEqual(b);
    a.forEach((x) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    });
  });

  test("a different total or profile gives a different sequence", () => {
    const base = take(seededRng("cycling", 2_500_000));
    expect(take(seededRng("cycling", 2_501_000))).not.toEqual(base);
    expect(take(seededRng("walking", 2_500_000))).not.toEqual(base);
  });
});
