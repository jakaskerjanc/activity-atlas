import { afterEach, describe, expect, test, vi } from "vitest";
import polyline from "@mapbox/polyline";
import {
  CITY_PAYLOAD_VERSION,
  CITY_ROUTE_VERSION,
  decodeCities,
  decodeCityRoute,
  loadCities,
  loadCityRoute,
} from "./cities";
import type { CityDistancePayload, CityRouteFile, EncodedCity } from "./types";

/** Encode a [lng, lat] path the way scripts/build-city-distances.ts does. */
function encodeLngLat(coords: [number, number][]): string {
  return polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
}

const PATH: [number, number][] = [
  [14.5058, 46.0569],
  [15.2, 45.95],
  [15.9819, 45.815],
];

function city(over: Partial<EncodedCity> = {}): EncodedCity {
  return {
    id: 3186886, name: "Zagreb", country: "HR", fc: "PPLC",
    lat: 45.815, lon: 15.9819, population: 698966,
    cycling: { m: 153000 },
    walking: null,
    ...over,
  };
}

function payload(cities: EncodedCity[], v = CITY_PAYLOAD_VERSION): CityDistancePayload {
  return {
    v, generated: "2026-10-04", router: "osrm-fossgis", simplifyM: 500,
    origin: { name: "Ljubljana", lat: 46.0569, lon: 14.5058 }, cities,
  };
}

const routeFile = (over: Partial<CityRouteFile> = {}): CityRouteFile => ({
  v: CITY_ROUTE_VERSION,
  cycling: encodeLngLat(PATH),
  ...over,
});

describe("decodeCities", () => {
  test("keeps the distances and the scalar fields", () => {
    const { origin, cities } = decodeCities(payload([city()]));
    expect(origin).toEqual({ name: "Ljubljana", lat: 46.0569, lon: 14.5058 });
    const [c] = cities;
    expect(c.name).toBe("Zagreb");
    expect(c.fc).toBe("PPLC");
    expect(c.cycling).toEqual({ m: 153000 });
  });

  test("preserves null profiles", () => {
    const [c] = decodeCities(payload([city()])).cities;
    expect(c.walking).toBeNull();
  });

  test("rejects the old file with the lines inline, and an unknown version", () => {
    expect(() => decodeCities(payload([city()], 1))).toThrow(/version 1/);
    expect(() => decodeCities(payload([city()], 99))).toThrow(/version 99/);
  });
});

describe("decodeCityRoute", () => {
  test("decodes a profile's line to [lng, lat]", () => {
    const coords = decodeCityRoute(routeFile(), "cycling");
    expect(coords).toHaveLength(3);
    coords.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(PATH[i][0], 5);
      expect(lat).toBeCloseTo(PATH[i][1], 5);
    });
  });

  test("refuses a missing profile, a degenerate line and an unknown version", () => {
    expect(() => decodeCityRoute(routeFile(), "walking")).toThrow(/No walking route/);
    expect(() => decodeCityRoute(routeFile({ cycling: encodeLngLat([PATH[0]]) }), "cycling")).toThrow(/fewer than 2/);
    expect(() => decodeCityRoute(routeFile({ v: 9 }), "cycling")).toThrow(/version 9/);
  });
});

describe("loading", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("loadCities forgets a failed load, then fetches, decodes and keeps the dataset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    await expect(loadCities()).rejects.toThrow(/404/);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload([city()]))));
    vi.stubGlobal("fetch", fetchMock);
    const data = await loadCities();
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}city-distances.json`);
    expect(data.cities[0].cycling).toEqual({ m: 153000 });

    expect(await loadCities()).toBe(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("loadCityRoute forgets a failed load, then fetches each city's file once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    await expect(loadCityRoute(42, "cycling")).rejects.toThrow(/404/);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(routeFile({ walking: encodeLngLat([PATH[0], PATH[2]]) }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadCityRoute(42, "cycling")).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}city-routes/42.json`);
    expect(await loadCityRoute(42, "walking")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
