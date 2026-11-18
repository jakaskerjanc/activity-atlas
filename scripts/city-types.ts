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

/** One measured route, with its line (the cache, stage C, and the v1 wire format). */
export interface EncodedCityRoute {
  /** OSRM route distance, meters */
  m: number;
  /** Google-encoded polyline, [lat,lng] precision-5, simplified to `simplifyM`. */
  poly: string;
}

/** One measured city; a profile is null when OSRM had no acceptable route. */
export interface EncodedCity extends GeoCity {
  cycling: EncodedCityRoute | null;
  walking: EncodedCityRoute | null;
}

/** A route in the index: its distance only. The line is in the city's route file. */
export interface IndexedCityRoute {
  /** OSRM route distance, meters */
  m: number;
}

/** One city in the index; a profile is null when OSRM had no acceptable route. */
export interface IndexedCity extends GeoCity {
  cycling: IndexedCityRoute | null;
  walking: IndexedCityRoute | null;
}

/** What the index and the v1 file share. */
interface CityDistanceHeader {
  /** Wire-format version, bumped on breaking shape changes. */
  v: number;
  /** ISO date (YYYY-MM-DD) the dataset was built */
  generated: string;
  router: string;
  /** Douglas–Peucker tolerance (meters) applied before encoding */
  simplifyM: number;
  origin: { name: string } & LatLon;
}

/**
 * Root shape of app/public/city-distances.json (v2): every city's distances, no lines.
 * Sorted by cycling.m asc; cities with cycling: null last.
 */
export interface CityDistancePayload extends CityDistanceHeader {
  cities: IndexedCity[];
}

/** The v1 file: the same, with every route's line inline. Read by `--resplit` only. */
export interface CityDistancePayloadV1 extends CityDistanceHeader {
  cities: EncodedCity[];
}

/** app/public/city-routes/<id>.json: one city's lines, fetched when it is shown. */
export interface CityRouteFile {
  v: number;
  /** Google-encoded polyline, [lat,lng] precision-5. */
  cycling?: string;
  walking?: string;
}
