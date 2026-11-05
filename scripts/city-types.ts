// Types for the city-distance dataset (scripts/build-city-distances.ts →
// app/public/city-distances.json). Keep the wire types in sync with the
// frontend copy in app/src/types.ts.

/** Comparison group; also the per-city route key on the wire. */
export type Profile = "cycling" | "walking";

export interface LatLon {
  lat: number;
  lon: number;
}

/** One row of the vendored GeoNames subset (scripts/data/geonames-cities.json). */
export interface GeoCity extends LatLon {
  /** GeoNames geonameid — stable key. */
  id: number;
  name: string;
  /** ISO 3166-1 alpha-2 country code */
  country: string;
  population: number;
  /** GeoNames feature code: PPLC national capital, PPLA regional capital, PPL… */
  fc: string;
}

/** A stage A pick: a GeoCity plus its great-circle distance from the origin. */
export interface Candidate extends GeoCity {
  /** great-circle meters from the origin */
  gcM: number;
}

/** One measured route on the wire. */
export interface EncodedCityRoute {
  /** OSRM route distance, meters */
  m: number;
  /** Google-encoded polyline, [lat,lng] precision-5, simplified to `simplifyM`. */
  poly: string;
}

/** One city on the wire; a profile is null when OSRM had no acceptable route. */
export interface EncodedCity extends GeoCity {
  cycling: EncodedCityRoute | null;
  walking: EncodedCityRoute | null;
}

/** Root shape of app/public/city-distances.json. */
export interface CityDistancePayload {
  /** Wire-format version, bumped on breaking shape changes. */
  v: number;
  /** ISO date (YYYY-MM-DD) the dataset was built */
  generated: string;
  router: string;
  /** Douglas–Peucker tolerance (meters) applied before encoding */
  simplifyM: number;
  origin: { name: string } & LatLon;
  /** Sorted by cycling.m asc; cities with cycling: null last. */
  cities: EncodedCity[];
}
