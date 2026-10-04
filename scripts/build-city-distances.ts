// Build app/public/city-distances.json: recognizable cities at real bike/foot
// route distances from Ljubljana, with simplified route lines, so the app can
// say "you rode X km — that's Ljubljana → Y". Network-bound and slow (~18 min),
// so it runs manually (`pnpm run build:cities`) and its output is committed.
// See docs/2026-09-19-distance-city-comparison-design.md.
//
//   stage A (pure)    select ~520 candidates from the vendored GeoNames subset
//   stage B (network) measure each with OSRM bike + foot, 1 req/s, cached
//   stage C (pure)    validate coverage + sanity, report, write

import type { Candidate, GeoCity, LatLon } from "./city-types.ts";

export const ORIGIN = { name: "Ljubljana", lat: 46.0569, lon: 14.5058 };

// --- Stage A: selection -----------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in meters. */
export function haversineM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * [distance m, population floor] anchors, log-interpolated between and clamped
 * outside. Low near the origin so short totals have candidates; high far out so
 * distant picks stay recognizable.
 */
const POP_FLOOR_ANCHORS: [number, number][] = [
  [300_000, 15_000],
  [2_000_000, 50_000],
  [6_000_000, 100_000],
];

/** Minimum population a city needs to be a candidate at `distM` from the origin. */
export function popFloor(distM: number): number {
  const a = POP_FLOOR_ANCHORS;
  if (distM <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    const [d0, p0] = a[i - 1];
    const [d1, p1] = a[i];
    if (distM <= d1) {
      const t = Math.log(distM / d0) / Math.log(d1 / d0);
      return Math.round(p0 * (p1 / p0) ** t);
    }
  }
  return a[a.length - 1][1];
}

export const BUCKET_MIN_M = 20_000;
export const BUCKET_MAX_M = 12_000_000;
/** 20 log bins per decade → each bin ~12 % wide. */
export const BINS_PER_DECADE = 20;
const K_NEAR = 10;
const K_FAR = 3;
/** Buckets starting at or beyond this keep K_FAR (far routes dominate file size). */
const K_SPLIT_M = 6_000_000;
/** Rank multiplier for regional capitals (PPLA) within a bucket. */
const PPLA_RANK_BOOST = 1.5;

/** Log-spaced distance bucket, or null outside [BUCKET_MIN_M, BUCKET_MAX_M). */
export function bucketIndex(distM: number): number | null {
  if (!(distM >= BUCKET_MIN_M) || distM >= BUCKET_MAX_M) return null;
  return Math.floor(BINS_PER_DECADE * Math.log10(distM / BUCKET_MIN_M));
}

/** Lower edge (meters) of bucket `i`. */
export function bucketLowerM(i: number): number {
  return BUCKET_MIN_M * 10 ** (i / BINS_PER_DECADE);
}

/** How many cities bucket `i` keeps. */
export function bucketCap(i: number): number {
  return bucketLowerM(i) < K_SPLIT_M ? K_NEAR : K_FAR;
}

/** Capitals first, then (PPLA-boosted) population desc, then id for determinism. */
function compareRank(a: GeoCity, b: GeoCity): number {
  const capA = a.fc === "PPLC" ? 1 : 0;
  const capB = b.fc === "PPLC" ? 1 : 0;
  if (capA !== capB) return capB - capA;
  const score = (c: GeoCity) => c.population * (c.fc === "PPLA" ? PPLA_RANK_BOOST : 1);
  return score(b) - score(a) || a.id - b.id;
}

/**
 * Stage A: bucket cities by great-circle distance from `origin` and keep the
 * best-known few per bucket. Great-circle is only a coarse filter; matching
 * later uses the real route distance from stage B.
 */
export function selectCandidates(cities: GeoCity[], origin: LatLon = ORIGIN): Candidate[] {
  const buckets = new Map<number, Candidate[]>();
  for (const c of cities) {
    const gcM = haversineM(origin, c);
    const b = bucketIndex(gcM);
    if (b === null || c.population < popFloor(gcM)) continue;
    const list = buckets.get(b) ?? [];
    list.push({ ...c, gcM });
    buckets.set(b, list);
  }
  const out: Candidate[] = [];
  for (const [b, list] of buckets) out.push(...list.sort(compareRank).slice(0, bucketCap(b)));
  return out.sort((x, y) => x.gcM - y.gcM || x.id - y.id);
}
