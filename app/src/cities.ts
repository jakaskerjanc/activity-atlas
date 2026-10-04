// Load the precomputed city-distances.json (built offline by
// scripts/build-city-distances.ts) and decode each route once into [lng, lat]
// coordinates a map layer can draw directly. Not imported at startup — the UI
// decides when to call loadCities(). Keep in sync with the encoder side.

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

/** Expand a city-distances.json payload. Throws on an unknown version. */
export function decodeCities(payload: CityDistancePayload): CityDistance[] {
  if (payload.v !== CITY_PAYLOAD_VERSION) {
    throw new Error(
      `Unsupported city-distances payload version ${payload.v} (expected ${CITY_PAYLOAD_VERSION})`,
    );
  }
  return payload.cities.map(({ cycling, walking, ...city }) => ({
    ...city,
    cycling: decodeRoute(cycling),
    walking: decodeRoute(walking),
  }));
}

/** Fetch + decode the dataset (~1 MB gz); call lazily. */
export async function loadCities(signal?: AbortSignal): Promise<CityDistance[]> {
  const r = await fetch(CITIES_URL, { signal });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return decodeCities((await r.json()) as CityDistancePayload);
}
