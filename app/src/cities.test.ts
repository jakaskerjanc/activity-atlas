import { afterEach, describe, expect, test, vi } from "vitest";
import polyline from "@mapbox/polyline";
import { CITY_PAYLOAD_VERSION, decodeCities, loadCities } from "./cities";
import type { CityDistancePayload, EncodedCity } from "./types";

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
    cycling: { m: 153000, poly: encodeLngLat(PATH) },
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

describe("decodeCities", () => {
  test("decodes polylines to [lng, lat] and keeps scalar fields", () => {
    const { origin, cities } = decodeCities(payload([city()]));
    expect(origin).toEqual({ name: "Ljubljana", lat: 46.0569, lon: 14.5058 });
    const [c] = cities;
    expect(c.name).toBe("Zagreb");
    expect(c.fc).toBe("PPLC");
    expect(c.cycling?.m).toBe(153000);
    expect(c.cycling?.coords).toHaveLength(3);
    c.cycling!.coords.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(PATH[i][0], 5);
      expect(lat).toBeCloseTo(PATH[i][1], 5);
    });
  });

  test("preserves null profiles", () => {
    const [c] = decodeCities(payload([city()])).cities;
    expect(c.walking).toBeNull();
  });

  test("a degenerate (< 2 point) route decodes to null", () => {
    const [c] = decodeCities(payload([city({ walking: { m: 1, poly: encodeLngLat([PATH[0]]) } })])).cities;
    expect(c.walking).toBeNull();
  });

  test("rejects an unknown payload version", () => {
    expect(() => decodeCities(payload([city()], 99))).toThrow(/version 99/);
  });
});

describe("loadCities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("forgets a failed load, then fetches, decodes and keeps the dataset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    await expect(loadCities()).rejects.toThrow(/404/);

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload([city()]))));
    vi.stubGlobal("fetch", fetchMock);
    const data = await loadCities();
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}city-distances.json`);
    expect(data.cities[0].cycling?.coords).toHaveLength(3);

    expect(await loadCities()).toBe(data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
