import { describe, expect, test } from "vitest";
import { activityGroup, cityComparisons, groupTotals, pickCity, seededRng } from "./cityMatch";
import type { CityDistance } from "./cities";
import { record } from "./testFixtures";

const activity = (type: string, distance: number | undefined) =>
  record({ id: `s:${type}${distance}`, type, distance });

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
      activity("Ride", 40_000),
      activity("GravelRide", 10_000),
      activity("Run", 8_000),
      activity("Hike", 12_000),
      activity("VirtualRide", 30_000),
      activity("Swim", 2_000),
    ]);
    expect(totals).toEqual({ cycling: 50_000, walking: 20_000 });
  });

  test("an unknown distance counts as nothing", () => {
    expect(groupTotals([activity("Ride", undefined), activity("Ride", 5_000)])).toEqual({
      cycling: 5_000,
      walking: 0,
    });
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
    expect(pick.ratio).toBeCloseTo(152 / 150);
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
    expect(pick.ratio).toBeCloseTo(0.4);
  });

  test("beyond the farthest city (+40 %) → over", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    const over = pickCity(cities, km(15_000), "cycling", first);
    expect(over).toMatchObject({ kind: "over", city: { id: 2 } });
    expect(over.ratio).toBeCloseTo(1.5);
    expect(pickCity(cities, km(13_000), "cycling", first)).toMatchObject({ kind: "match", city: { id: 2 } });
  });

  test("short of the nearest city (−40 %) → under", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    const under = pickCity(cities, km(10), "cycling", first);
    expect(under).toMatchObject({ kind: "under", city: { id: 1 } });
    expect(under.ratio).toBeCloseTo(0.5);
  });

  test("zero or negative total → under with a 0 ratio, never a NaN", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    for (const target of [0, -5, Number.NaN]) {
      expect(pickCity(cities, target, "cycling", first)).toMatchObject({ kind: "under", ratio: 0 });
    }
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

describe("cityComparisons", () => {
  const cities = [
    c(1, 100, { walking: { m: km(90), coords: [[0, 0], [1, 1]] } }),
    c(2, 2_000),
  ];

  test("one comparison per group with distance, cycling first", () => {
    const out = cityComparisons(
      [activity("Run", km(50)), activity("Walk", km(40)), activity("Ride", km(1_900))],
      cities,
    );
    expect(out.map((x) => [x.profile, x.totalM, x.pick.city.id])).toEqual([
      ["cycling", km(1_900), 2],
      ["walking", km(90), 1],
    ]);
  });

  test("leaves out a group without distance, or without any city to compare", () => {
    expect(cityComparisons([activity("Ride", km(100)), activity("Swim", km(2))], cities)).toHaveLength(1);
    expect(cityComparisons([activity("Run", km(10))], [c(2, 2_000)])).toEqual([]);
    expect(cityComparisons([], cities)).toEqual([]);
  });

  test("the same activities always pick the same city", () => {
    const many = Array.from({ length: 10 }, (_, i) => c(i + 1, 100 + i));
    const rides = [activity("Ride", km(104))];
    expect(cityComparisons(rides, many)).toEqual(cityComparisons(rides, many));
  });
});
