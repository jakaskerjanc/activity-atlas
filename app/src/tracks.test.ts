import { describe, expect, test } from "vitest";
import polyline from "@mapbox/polyline";
import { ACTIVITIES_VERSION, joinActivities, ROUTES_VERSION } from "./tracks";
import type { ActivitiesFile, ActivityRecord, RoutesFile } from "./types";

/** Encode a [lng, lat] path the way scripts/build-tracks.ts does. */
function encodeLngLat(coords: [number, number][]): string {
  return polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
}

function record(over: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id: "k3j9x0",
    name: "Test",
    type: "Run",
    ts: 1723975135,
    start_date: "2024-08-18T09:58:55Z",
    distance: 10000,
    moving_time: 3000,
    elevation_gain: 100,
    channels: ["gps"],
    sources: [{ provider: "strava", id: "1" }],
    ...over,
  };
}

const PATH: [number, number][] = [
  [14.48691, 46.05017],
  [14.4906, 46.05243],
  [14.49459, 46.05698],
];

const routes = (r: Record<string, string>): RoutesFile => ({ v: ROUTES_VERSION, routes: r });
const acts = (a: ActivityRecord[]): ActivitiesFile => ({ v: ACTIVITIES_VERSION, activities: a });

describe("joinActivities", () => {
  test("joins routes onto records by id", () => {
    const fc = joinActivities(
      routes({ a: encodeLngLat(PATH), b: encodeLngLat(PATH) }),
      acts([record({ id: "a", name: "First" }), record({ id: "b", name: "Second" })]),
    );
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.map((f) => f.properties.name)).toEqual(["First", "Second"]);
    expect(fc.features[0].geometry.type).toBe("LineString");
  });

  test("round-trips coordinates in [lng, lat] order (5-decimal precision)", () => {
    const fc = joinActivities(routes({ k3j9x0: encodeLngLat(PATH) }), acts([record()]));
    const coords = fc.features[0].geometry.coordinates as [number, number][];
    expect(coords).toHaveLength(PATH.length);
    coords.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(PATH[i][0], 5);
      expect(lat).toBeCloseTo(PATH[i][1], 5);
      expect(lng).toBeLessThan(lat);
    });
  });

  test("skips records without a route", () => {
    const fc = joinActivities(
      routes({ a: encodeLngLat(PATH) }),
      acts([record({ id: "a" }), record({ id: "gym", distance: undefined })]),
    );
    expect(fc.features.map((f) => f.properties.id)).toEqual(["a"]);
  });

  test("skips a route under 2 points", () => {
    const fc = joinActivities(routes({ a: encodeLngLat([PATH[0]]) }), acts([record({ id: "a" })]));
    expect(fc.features).toHaveLength(0);
  });

  test("throws on routes v3", () => {
    expect(() =>
      joinActivities({ v: 3, routes: {} } as unknown as RoutesFile, acts([])),
    ).toThrow(/routes.*version 3/i);
  });

  test("throws on activities v2", () => {
    expect(() =>
      joinActivities(routes({}), { v: 2, activities: [] } as unknown as ActivitiesFile),
    ).toThrow(/activities.*version 2/i);
  });

  test("poly does not leak into properties, the record is carried whole", () => {
    const rec = record({ avg_hr: 140, detail: true });
    const fc = joinActivities(routes({ k3j9x0: encodeLngLat(PATH) }), acts([rec]));
    expect(fc.features[0].properties).toEqual(rec);
    expect("poly" in fc.features[0].properties).toBe(false);
  });
});
