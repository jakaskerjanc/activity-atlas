// Load the precomputed city-distances.json (built offline by
// scripts/build-city-distances.ts) and decode each route once into [lng, lat]
// coordinates a map layer can draw directly. Fetched the first time the analytics page
// (or a city route on the map) needs it, then kept for the session. Keep in sync with
// the encoder side.

import polyline from "@mapbox/polyline";
import type { CityDistancePayload, EncodedCityRoute } from "./types";

/** Wire-format version this decoder understands (see scripts/build-city-distances.ts). */
export const CITY_PAYLOAD_VERSION = 1;

const CITIES_URL = `${import.meta.env.BASE_URL}city-distances.json`;

export interface CityRoute {
  /** route distance, meters */
  m: number;
  /** [lng, lat] */
  coords: [number, number][];
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

function decodeRoute(route: EncodedCityRoute | null): CityRoute | null {
  if (!route) return null;
  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  const coords = polyline.decode(route.poly).map(([lat, lng]) => [lng, lat] as [number, number]);
  // A drawable line needs >= 2 points; treat a corrupt route as missing.
  return coords.length < 2 ? null : { m: route.m, coords };
}

/** The decoded dataset: the routes' common start and every city. */
export interface CityData {
  origin: CityOrigin;
  cities: CityDistance[];
}

/** Expand a city-distances.json payload. Throws on an unknown version. */
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
      cycling: decodeRoute(cycling),
      walking: decodeRoute(walking),
    })),
  };
}

let cached: Promise<CityData> | null = null;

/** Fetch + decode the dataset (~300 KB gz) once. A failed load is forgotten, so the next
 * call retries. */
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
