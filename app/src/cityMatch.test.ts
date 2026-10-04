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

import { pickCity } from "./cityMatch";
import type { CityDistance } from "./cities";

function c(
  id: number,
  cyclingKm: number | null,
  over: Partial<Omit<CityDistance, "cycling">> = {},
): CityDistance {
  return {
    id, name: `C${id}`, country: "XX", fc: "PPL", lat: 0, lon: 0, population: 100,
    cycling: cyclingKm === null ? null : { m: cyclingKm * 1000, coords: [[0, 0], [1, 1]] },
    walking: null,
    ...over,
  };
}

const first = () => 0;
const km = (n: number) => n * 1000;

describe("pickCity", () => {
  test("in-band match with its ratio", () => {
    const pick = pickCity([c(1, 100), c(2, 150), c(3, 200)], km(152), "cycling", first);
    expect(pick).toMatchObject({ kind: "match", city: { id: 2 } });
    if (pick.kind === "match") expect(pick.ratio).toBeCloseTo(152 / 150);
  });

  test("widens the band progressively (5 → 10 → 20 %)", () => {
    // ±5 % and ±10 % of 120 km are empty; ±20 % reaches 100 km but not 200 km.
    const pick = pickCity([c(1, 100), c(2, 200)], km(120), "cycling", first);
    expect(pick).toMatchObject({ kind: "match", city: { id: 1 } });
  });

  test("in-range gap → closest by log ratio, not by absolute distance", () => {
    // 400 km: nothing within ±40 %. |log(1000/400)| < |log(100/400)|.
    const pick = pickCity([c(1, 100), c(2, 1000)], km(400), "cycling", first);
    expect(pick).toMatchObject({ kind: "match", city: { id: 2 } });
    if (pick.kind === "match") expect(pick.ratio).toBeCloseTo(0.4);
  });

  test("beyond the farthest city (+40 %) → over", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    expect(pickCity(cities, km(15_000), "cycling", first)).toMatchObject({ kind: "over", farthest: { id: 2 } });
    expect(pickCity(cities, km(13_000), "cycling", first)).toMatchObject({ kind: "match", city: { id: 2 } });
  });

  test("short of the nearest city (−40 %) → under", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    expect(pickCity(cities, km(10), "cycling", first)).toMatchObject({ kind: "under", nearest: { id: 1 } });
  });

  test("zero or negative total → under, never a 0/NaN ratio match", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    expect(pickCity(cities, 0, "cycling", first).kind).toBe("under");
    expect(pickCity(cities, -5, "cycling", first).kind).toBe("under");
    expect(pickCity(cities, Number.NaN, "cycling", first).kind).toBe("under");
  });

  test("capitals weigh 2x population", () => {
    // Weights 100 | 200 → rng 0.4 lands at 120, inside the capital's share.
    const cities = [c(1, 100), c(2, 101, { fc: "PPLC" })];
    expect(pickCity(cities, km(100.5), "cycling", () => 0.4)).toMatchObject({ city: { id: 2 } });
    // Control: without the boost (100 | 100) the same rng lands at 80 → city 1.
    expect(pickCity([c(1, 100), c(2, 101)], km(100.5), "cycling", () => 0.4)).toMatchObject({ city: { id: 1 } });
  });

  test("regional capitals weigh 1.5x population", () => {
    // Weights 100 | 150 → rng 0.42 lands at 105 → city 2; control lands at 84 → city 1.
    const cities = [c(1, 100), c(2, 101, { fc: "PPLA" })];
    expect(pickCity(cities, km(100.5), "cycling", () => 0.42)).toMatchObject({ city: { id: 2 } });
    expect(pickCity([c(1, 100), c(2, 101)], km(100.5), "cycling", () => 0.42)).toMatchObject({ city: { id: 1 } });
  });

  test("profile isolation: cities without a route for the profile are ignored", () => {
    const bikeOnly = c(1, 100);
    const footOnly = c(2, null, { walking: { m: km(100), coords: [[0, 0], [1, 1]] } });
    expect(pickCity([bikeOnly, footOnly], km(100), "walking", first)).toMatchObject({ city: { id: 2 } });
    expect(pickCity([bikeOnly, footOnly], km(100), "cycling", first)).toMatchObject({ city: { id: 1 } });
  });

  test("throws when no city has a route for the profile", () => {
    expect(() => pickCity([c(1, 100)], km(100), "walking", first)).toThrow(/walking/);
  });

  test("seeded rng makes the pick reproducible", () => {
    const cities = Array.from({ length: 10 }, (_, i) => c(i + 1, 100 + i, { population: 100 + i * 50 }));
    const a = pickCity(cities, km(104), "cycling", seededRng("cycling", km(104)));
    const b = pickCity(cities, km(104), "cycling", seededRng("cycling", km(104)));
    expect(a).toEqual(b);
  });
});
