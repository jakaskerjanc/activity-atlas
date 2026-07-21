import { describe, expect, test } from "vitest";
import {
  ACCENT,
  computeDomain,
  lineColorExpression,
  legendFor,
  typeColor,
  type ColorDomain,
} from "./colors";
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
      moving_time: 3600,
      elevation_gain: 100,
      ...props,
    },
  };
}

const domain = (over: Partial<ColorDomain> = {}): ColorDomain => ({
  tsMin: 0,
  tsMax: 100,
  elevMin: 0,
  elevMax: 500,
  speedMin: 5,
  speedMax: 20,
  types: ["Hike", "Ride", "Run"],
  ...over,
});

describe("computeDomain", () => {
  test("collects sorted distinct types and ts bounds", () => {
    const d = computeDomain([
      feature({ type: "Run", ts: 300 }),
      feature({ type: "Hike", ts: 100 }),
      feature({ type: "Run", ts: 200 }),
    ]);
    expect(d.types).toEqual(["Hike", "Run"]);
    expect(d.tsMin).toBe(100);
    expect(d.tsMax).toBe(300);
  });

  test("speed is km/h from distance and moving time", () => {
    // 10 km in 1 h -> 10 km/h for every feature, so both percentiles land on it.
    const d = computeDomain([feature({ distance: 10000, moving_time: 3600 })]);
    expect(d.speedMin).toBeCloseTo(10);
    expect(d.speedMax).toBeCloseTo(10);
  });

  test("elevation percentiles resist a single outlier", () => {
    const feats = [
      ...Array.from({ length: 20 }, () => feature({ elevation_gain: 100 })),
      feature({ elevation_gain: 100000 }), // monster climb outlier
    ];
    const d = computeDomain(feats);
    expect(d.elevMax).toBeLessThan(100000);
  });

  test("empty input is all zeros with no types", () => {
    const d = computeDomain([]);
    expect(d).toEqual({
      tsMin: 0,
      tsMax: 0,
      elevMin: 0,
      elevMax: 0,
      speedMin: 0,
      speedMax: 0,
      types: [],
    });
  });
});

describe("lineColorExpression", () => {
  test("uniform and heat are the plain accent color", () => {
    expect(lineColorExpression("uniform", domain())).toBe(ACCENT);
    expect(lineColorExpression("heat", domain())).toBe(ACCENT);
  });

  test("recency is an ascending interpolate over the ts domain", () => {
    const expr = lineColorExpression("recency", domain({ tsMin: 0, tsMax: 100 }));
    expect(Array.isArray(expr)).toBe(true);
    const arr = expr as unknown[];
    expect(arr[0]).toBe("interpolate");
    expect(arr[2]).toEqual(["get", "ts"]);
    // positions at indices 3,5,7 must strictly ascend across [0,100].
    expect(arr[3]).toBe(0);
    expect(arr[7]).toBe(100);
    expect(Number(arr[3])).toBeLessThan(Number(arr[5]));
    expect(Number(arr[5])).toBeLessThan(Number(arr[7]));
  });

  test("degenerate domain (min == max) still yields a valid ascending ramp", () => {
    const expr = lineColorExpression("elevation", domain({ elevMin: 42, elevMax: 42 }));
    const arr = expr as unknown[];
    expect(Number(arr[3])).toBeLessThan(Number(arr[arr.length - 2]));
  });

  test("type is a match with a pair per type plus a fallback", () => {
    const expr = lineColorExpression("type", domain({ types: ["Hike", "Ride"] }));
    const arr = expr as unknown[];
    expect(arr[0]).toBe("match");
    expect(arr[1]).toEqual(["get", "type"]);
    expect(arr[2]).toBe("Hike");
    expect(arr[4]).toBe("Ride");
    expect(arr[arr.length - 1]).toBe(ACCENT); // fallback
  });

  test("type with no types falls back to accent", () => {
    expect(lineColorExpression("type", domain({ types: [] }))).toBe(ACCENT);
  });
});

describe("typeColor", () => {
  test("is deterministic and distinct across the first types", () => {
    const types = ["Hike", "Ride", "Run"];
    const colors = types.map((t) => typeColor(t, types));
    expect(new Set(colors).size).toBe(3);
    expect(typeColor("Ride", types)).toBe(typeColor("Ride", types));
  });
});

describe("legendFor", () => {
  test("uniform has no legend", () => {
    expect(legendFor("uniform", domain())).toEqual({ kind: "none" });
  });

  test("speed legend labels carry the km/h unit and rounded bounds", () => {
    const leg = legendFor("speed", domain({ speedMin: 4.6, speedMax: 19.2 }));
    expect(leg).toMatchObject({ kind: "gradient", minLabel: "5", maxLabel: "19 km/h" });
  });

  test("type legend has one colored entry per type", () => {
    const leg = legendFor("type", domain({ types: ["Hike", "Ride"] }));
    expect(leg).toMatchObject({ kind: "categorical" });
    if (leg.kind === "categorical") {
      expect(leg.entries.map((e) => e.label)).toEqual(["Hike", "Ride"]);
      expect(leg.entries[0].color).toBe(typeColor("Hike", ["Hike", "Ride"]));
    }
  });
});
