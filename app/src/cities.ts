// Load the precomputed city distances (built offline by scripts/build-city-distances.ts).
// city-distances.json holds every city's route distances, fetched the first time the
// analytics page (or a city route on the map) needs it, then kept for the session. Each
// city's route lines are in their own file, city-routes/<id>.json, fetched only when the
// map shows that city (loadCityRoute). Keep in sync with the encoder side.

import polyline from "@mapbox/polyline";
import type { CityDistancePayload, CityRouteFile, Profile } from "./types";

/** Wire-format version this decoder understands (see scripts/build-city-distances.ts). */
export const CITY_PAYLOAD_VERSION = 2;
/** Route-file version this decoder understands (see scripts/build-city-distances.ts). */
export const CITY_ROUTE_VERSION = 1;

const CITIES_URL = `${import.meta.env.BASE_URL}city-distances.json`;
const cityRouteUrl = (id: number) => `${import.meta.env.BASE_URL}city-routes/${id}.json`;

export interface CityRoute {
  /** route distance, meters */
  m: number;
}

/** Where every route starts. */
export interface CityOrigin {
  name: string;
  lat: number;
  lon: number;
}

export interface CityDistance {
  id: number;
  name: string;
  country: string;
  fc: string;
  lat: number;
  lon: number;
  population: number;
  cycling: CityRoute | null;
  walking: CityRoute | null;
}

/** The decoded dataset: the routes' common start and every city. */
export interface CityData {
  origin: CityOrigin;
  cities: CityDistance[];
}

/** Read a city-distances.json payload. Throws on an unknown version. */
export function decodeCities(payload: CityDistancePayload): CityData {
  if (payload.v !== CITY_PAYLOAD_VERSION) {
    throw new Error(
      `Unsupported city-distances payload version ${payload.v} (expected ${CITY_PAYLOAD_VERSION})`,
    );
  }
  return {
    origin: payload.origin,
    cities: payload.cities.map(({ cycling, walking, ...city }) => ({
      ...city,
      cycling: cycling ? { m: cycling.m } : null,
      walking: walking ? { m: walking.m } : null,
    })),
  };
}

let cached: Promise<CityData> | null = null;

/** Fetch the dataset (~10 KB gz) once. A failed load is forgotten, so the next call
 * retries. */
export function loadCities(): Promise<CityData> {
  if (!cached) {
    const p = fetch(CITIES_URL).then(async (r) => {
      if (!r.ok) throw new Error(`${CITIES_URL}: ${r.status} ${r.statusText}`);
      return decodeCities((await r.json()) as CityDistancePayload);
    });
    p.catch(() => {
      if (cached === p) cached = null;
    });
    cached = p;
  }
  return cached;
}

/** One profile's line from a city's route file, as [lng, lat]. Throws if it has none. */
export function decodeCityRoute(file: CityRouteFile, profile: Profile): [number, number][] {
  if (file.v !== CITY_ROUTE_VERSION) {
    throw new Error(`Unsupported city route version ${file.v} (expected ${CITY_ROUTE_VERSION})`);
  }
  const poly = file[profile];
  if (poly === undefined) throw new Error(`No ${profile} route in this city's file`);
  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  const coords = polyline.decode(poly).map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) throw new Error(`The ${profile} route has fewer than 2 points`);
  return coords;
}

const routeFiles = new Map<number, Promise<CityRouteFile>>();

/**
 * A city's route for a profile, as [lng, lat]. Its file (both profiles) is fetched once
 * per session; a failed fetch is forgotten, so the next call retries.
 */
export function loadCityRoute(id: number, profile: Profile): Promise<[number, number][]> {
  let file = routeFiles.get(id);
  if (!file) {
    const url = cityRouteUrl(id);
    const p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
      return (await r.json()) as CityRouteFile;
    });
    p.catch(() => {
      if (routeFiles.get(id) === p) routeFiles.delete(id);
    });
    routeFiles.set(id, p);
    file = p;
  }
  return file.then((f) => decodeCityRoute(f, profile));
}
