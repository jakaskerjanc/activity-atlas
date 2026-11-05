import { describe, expect, test } from "vitest";
import { validate } from "mapbox-gl/dist/style-spec/index.es.js";
import {
  GRADE_MAX,
  GRADE_SCALE,
  bucketGrade,
  gradeColor,
  gradeRoutes,
  lineGradient,
  profileGrades,
  splitRoute,
} from "./grade";
import { lineColorExpression } from "./colors";
import { activity } from "./testFixtures";
import type { ActivityFeature, ActivityRecord } from "./types";

const BLUE = "#3d8bfd";
const GREEN = "#3ecf6e";
const RED = "#ff3b30";

/** Degrees of latitude per metre on the sphere grade.ts measures on. */
const DEG_PER_M = 180 / (Math.PI * 6371008.8);

/** A straight line due north from (14, 46): one segment of `metres`. */
function north(metres: number): [number, number][] {
  return [
    [14, 46],
    [14, 46 + metres * DEG_PER_M],
  ];
}

function routed(coordinates: [number, number][], props: Partial<ActivityRecord> = {}): ActivityFeature {
  const f = activity(props);
  return { ...f, geometry: { type: "LineString", coordinates } };
}

describe("profileGrades", () => {
  test("is rise over run between neighbours, in %", () => {
    expect(profileGrades([0, 10, 20, 20], 100)).toEqual([10, 10, 5, 0]);
  });
});

describe("bucketGrade", () => {
  test("rounds to the bucket and clamps at the scale's ends", () => {
    expect(bucketGrade(10)).toBe(10.5);
    expect(bucketGrade(40)).toBe(GRADE_MAX);
    expect(bucketGrade(-40)).toBe(-GRADE_MAX);
  });

  test("a slight descent is flat, not -0", () => {
    expect(Object.is(bucketGrade(-0.3), 0)).toBe(true);
  });
});

describe("splitRoute", () => {
  test("a constant slope is one run", () => {
    const profile = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]; // 5% over 1 km
    const { runs } = splitRoute(north(1000), profile, 100, 1000);
    expect(runs.map((r) => r.grade)).toEqual([bucketGrade(5)]);
  });

  test("a long straight segment still changes color where the grade does", () => {
    // 10% for 500 m, then flat; the line is a single 1 km segment.
    const profile = [0, 10, 20, 30, 40, 50, 50, 50, 50, 50, 50];
    const { runs, length } = splitRoute(north(1000), profile, 100, 1000);
    expect(length).toBeCloseTo(1000, 3);
    expect(runs.map((r) => r.grade)).toEqual([10.5, 7.5, 3, 0]);
    expect(runs.map((r) => Math.round(r.start))).toEqual([0, 400, 500, 600]);
  });

  test("neighbouring runs share their boundary point", () => {
    const profile = [0, 10, 20, 30, 40, 50, 50, 50, 50, 50, 50];
    const { runs } = splitRoute(north(1000), profile, 100, 1000);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].coordinates[0]).toEqual(runs[i - 1].coordinates.at(-1));
    }
    expect(runs[0].coordinates[0]).toEqual([14, 46]);
    expect(runs.at(-1)!.coordinates.at(-1)).toEqual(north(1000)[1]);
  });

  test("the profile is read in recorded distance, not the line's length", () => {
    // The line is 1 km but the activity recorded 2 km: the climb's first km (10%)
    // covers the line's first half.
    const profile = [...Array.from({ length: 11 }, (_, i) => i * 10), ...Array(10).fill(100)];
    const { runs } = splitRoute(north(1000), profile, 100, 2000);
    const climb = runs.filter((r) => r.grade === 10.5);
    expect(climb).toHaveLength(1);
    expect(runs[0].grade).toBe(10.5);
    expect(runs.find((r) => r.grade === 0)!.start).toBeGreaterThan(500);
  });
});

describe("gradeRoutes", () => {
  const profiles = { v: 1 as const, step: 100, profiles: { "s:1": [0, 10, 20, 30, 40, 50, 50, 50, 50, 50, 50] } };

  test("splits profiled routes into runs that keep the activity's id, type and ts", () => {
    const data = { type: "FeatureCollection" as const, features: [routed(north(1000), { id: "s:1", type: "Hike", ts: 7, distance: 1000 })] };
    const { collection, stops } = gradeRoutes(data, profiles);
    expect(collection.features).toHaveLength(4);
    for (const f of collection.features) {
      expect(f.properties).toMatchObject({ id: "s:1", type: "Hike", ts: 7 });
      expect(f.properties.grade).toBeTypeOf("number");
    }
    expect(stops.get("s:1")!.map((s) => s.from)).toEqual([0, 0.4, 0.5, 0.6].map((x) => expect.closeTo(x, 6)));
  });

  test("a route without a profile stays whole and has no grade (draws neutral)", () => {
    const data = { type: "FeatureCollection" as const, features: [routed(north(1000), { id: "s:2" })] };
    const { collection, stops } = gradeRoutes(data, profiles);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].properties).toEqual({ id: "s:2", type: "Run", ts: 1723975135 });
    expect(collection.features[0].geometry.coordinates).toEqual(north(1000));
    expect(stops.has("s:2")).toBe(false);
  });
});

describe("gradeColor", () => {
  test("hits every stop of the scale and saturates past its ends", () => {
    for (const s of GRADE_SCALE) expect(gradeColor(s.grade)).toBe(s.color);
    expect(gradeColor(-99)).toBe(BLUE);
    expect(gradeColor(99)).toBe(RED);
  });

  test("flat stays green both ways; steeper climbs pass through orange", () => {
    expect(gradeColor(-2)).toBe(GREEN);
    expect(gradeColor(0)).toBe(GREEN);
    expect(gradeColor(2)).toBe(GREEN);
    expect(gradeColor(11.25)).toBe("#ff8738"); // halfway yellow -> red
  });
});

describe("lineGradient", () => {
  test("steps over line-progress at each run's start", () => {
    const expr = lineGradient([
      { from: 0, grade: 15 },
      { from: 0.4, grade: 0 },
      { from: 0.7, grade: -15 },
    ]) as unknown[];
    expect(expr).toEqual(["step", ["line-progress"], RED, 0.4, GREEN, 0.7, BLUE]);
  });

  test("a one-run route is a single color over the whole line", () => {
    expect(lineGradient([{ from: 0, grade: 0 }])).toEqual([
      "interpolate",
      ["linear"],
      ["line-progress"],
      0,
      GREEN,
      1,
      GREEN,
    ]);
  });
});

describe("as Mapbox reads them", () => {
  /** Style-spec errors for one line layer with these paint values. */
  function errors(paint: object): string[] {
    const style = {
      version: 8,
      sources: { s: { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true } },
      layers: [{ id: "l", type: "line", source: "s", paint }],
    };
    return validate(style).map((e) => e.message);
  }

  test("the line-gradients and the grade line-color are valid paint values", () => {
    const domain = { tsMin: 0, tsMax: 1, speedMin: 0, speedMax: 1, types: [] };
    expect(errors({ "line-color": lineColorExpression("elevation", domain) })).toEqual([]);
    expect(errors({ "line-gradient": lineGradient([{ from: 0, grade: 3 }, { from: 0.3, grade: -6 }]) })).toEqual([]);
    expect(errors({ "line-gradient": lineGradient([{ from: 0, grade: 3 }]) })).toEqual([]);
  });
});
