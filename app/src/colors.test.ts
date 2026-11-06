import { describe, expect, test } from "vitest";
import {
  ACCENT,
  NEUTRAL,
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
      id: "s:1",
      name: "Test",
      type: "Run",
      ts: 1000,
      start_date: "2024-08-18T09:58:55Z",
      distance: 10000,
      moving_time: 3600,
      elevation_gain: 100,
      channels: [],
      sources: [],
      ...props,
    },
  };
}

const domain = (over: Partial<ColorDomain> = {}): ColorDomain => ({
  tsMin: 0,
  tsMax: 100,
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

  test("narrowing the set never raises the max (monotonic under subsetting)", () => {
    const all = [
      feature({ distance: 5000, moving_time: 3600, ts: 1 }),
      feature({ distance: 10000, moving_time: 3600, ts: 2 }),
      feature({ distance: 30000, moving_time: 3600, ts: 3 }),
    ];
    const full = computeDomain(all);
    // A date-window subset that drops the fastest activity.
    const subset = computeDomain(all.filter((f) => f.properties.ts <= 2));
    expect(subset.speedMax).toBeLessThanOrEqual(full.speedMax);
  });

  test("empty input is all zeros with no types", () => {
    const d = computeDomain([]);
    expect(d).toEqual({
      tsMin: 0,
      tsMax: 0,
      speedMin: 0,
      speedMax: 0,
      types: [],
    });
  });
});

describe("unknown values", () => {
  test("domain ignores activities without distance or moving time for speed", () => {
    const d = computeDomain([
      feature({ distance: 10000, moving_time: 3600 }),
      feature({ distance: undefined }),
      feature({ moving_time: undefined }),
    ]);
    expect(d.speedMin).toBeCloseTo(10);
    expect(d.speedMax).toBeCloseTo(10);
  });

  test("elevation colors a run's grade and falls back to NEUTRAL without one", () => {
    const e = lineColorExpression("grade", domain()) as unknown[];
    expect(e[0]).toBe("case");
    expect(e[1]).toEqual(["has", "grade"]);
    expect((e[2] as unknown[]).slice(0, 3)).toEqual(["interpolate", ["linear"], ["get", "grade"]]);
    expect(e[e.length - 1]).toBe(NEUTRAL);
  });

  test("the elevation scale is fixed, whatever the visible set", () => {
    const wide = lineColorExpression("grade", domain({ tsMin: 0, speedMax: 90 }));
    const narrow = lineColorExpression("grade", domain({ tsMin: 50, speedMax: 6 }));
    expect(wide).toEqual(narrow);
    expect(legendFor("grade", domain({ speedMax: 90 }))).toEqual(legendFor("grade", domain()));
  });

  test("speed expression falls back to NEUTRAL when distance or time is absent", () => {
    const e = lineColorExpression("speed", domain()) as unknown[];
    expect(e[0]).toBe("case");
    expect(e[1]).toEqual(["all", ["has", "distance"], ["has", "moving_time"]]);
    expect(e[e.length - 1]).toBe(NEUTRAL);
  });
});

describe("lineColorExpression", () => {
  test("uniform is the plain accent color", () => {
    expect(lineColorExpression("uniform", domain())).toBe(ACCENT);
  });

  test("heat draws in the accent and lets overlaps build brightness, from rare to frequent", () => {
    expect(lineColorExpression("heat", domain())).toBe(ACCENT);
    for (const theme of ["dark", "light"] as const) {
      const legend = legendFor("heat", domain(), theme);
      expect(legend).toMatchObject({ kind: "gradient", minLabel: "Rare", maxLabel: "Frequent" });
      expect(legend.kind === "gradient" && legend.stops.at(-1)).toBe(ACCENT);
    }
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
    const expr = lineColorExpression("speed", domain({ speedMin: 42, speedMax: 42 }));
    const arr = (expr as unknown[])[2] as unknown[]; // the ramp inside the NEUTRAL case
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
  test("is distinct across the main types", () => {
    const colors = ["Run", "Ride", "Hike", "Walk"].map((t) => typeColor(t));
    expect(new Set(colors).size).toBe(4);
  });

  test("is fixed per type, whatever other types exist or how they are ordered", () => {
    // The map sorted types alphabetically and the analytics chart by frequency; with a
    // positional palette Run and Hike swapped colors between the two views.
    expect(typeColor("Run")).toBe("#2ec4b6");
    // No type wears the accent: it means the app and the selection.
    for (const t of ["Run", "Ride", "Hike", "Walk"]) expect(typeColor(t)).not.toBe(ACCENT);
    expect(typeColor("Hike")).toBe(typeColor("Hike", "dark"));
    expect(typeColor("Swim")).toBe(typeColor("Swim"));
  });

  test("has a deeper step for the light theme", () => {
    expect(typeColor("Hike", "light")).not.toBe(typeColor("Hike", "dark"));
  });
});

describe("legendFor", () => {
  test("uniform has no legend", () => {
    expect(legendFor("uniform", domain())).toEqual({ kind: "none" });
  });

  test("elevation legend is descent / flat / climb with the % bounds", () => {
    expect(legendFor("grade", domain())).toEqual({
      kind: "gradient",
      stops: [
        "#1d4a9e 0%",
        "#4f93e8 25%",
        "#8c919c 46.67%",
        "#8c919c 53.33%",
        "#ffab45 66.67%",
        "#f4502a 83.33%",
        "#a3150c 100%",
      ],
      minLabel: "−15% descent",
      midLabel: "flat",
      maxLabel: "+15% climb",
    });
  });

  test("speed legend labels carry the km/h unit and rounded bounds", () => {
    const leg = legendFor("speed", domain({ speedMin: 4.6, speedMax: 19.2 }));
    expect(leg).toMatchObject({ kind: "gradient", minLabel: "5 km/h", maxLabel: "19 km/h" });
  });

  test("type legend has one colored entry per type", () => {
    const leg = legendFor("type", domain({ types: ["Hike", "Ride"] }));
    expect(leg).toMatchObject({ kind: "categorical" });
    if (leg.kind === "categorical") {
      expect(leg.entries.map((e) => e.label)).toEqual(["Hike", "Ride"]);
      expect(leg.entries[0].color).toBe(typeColor("Hike"));
    }
  });
});
