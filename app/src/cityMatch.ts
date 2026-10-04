// Pure helpers that turn activity distance totals into a comparison city
// ("you rode X km — that's Ljubljana → Y"). No React / Mapbox deps.
// See docs/2026-09-19-distance-city-comparison-design.md.

import type { CityDistance, CityRoute } from "./cities";
import { isFootBased } from "./format";
import type { ActivityFeature, Profile } from "./types";

/** Which comparison an activity feeds; null = not a distance on the ground. */
export function activityGroup(type: string): Profile | null {
  if (/^virtual/i.test(type)) return null; // indoor trainer / treadmill
  if (/ride/i.test(type)) return "cycling";
  if (isFootBased(type)) return "walking";
  return null;
}

/** Total meters per group for whatever feature set the caller passes. */
export function groupTotals(features: ActivityFeature[]): Record<Profile, number> {
  const totals: Record<Profile, number> = { cycling: 0, walking: 0 };
  for (const f of features) {
    const group = activityGroup(f.properties.type);
    if (group) totals[group] += f.properties.distance;
  }
  return totals;
}

/** FNV-1a 32-bit string hash. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good-enough PRNG for picking a city. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic RNG seeded from the profile and the total rounded to the km:
 * the same filter always picks the same city; a different total may not.
 */
export function seededRng(profile: Profile, totalM: number): () => number {
  return mulberry32(hashString(`${profile}:${Math.round(totalM / 1000)}`));
}

// --- Picking a city ---------------------------------------------------------

export type CityPick =
  /** ratio = targetM / route.m */
  | { kind: "match"; city: CityDistance; route: CityRoute; ratio: number }
  /** target beyond the farthest city */
  | { kind: "over"; farthest: CityDistance; route: CityRoute }
  /** target short of the nearest city */
  | { kind: "under"; nearest: CityDistance; route: CityRoute };

/** Initial match band (±fraction of the target), doubled until MAX_BAND. */
export const BAND = 0.05;
export const MAX_BAND = 0.4;
const CAPITAL_WEIGHT = 2;
const REGIONAL_CAPITAL_WEIGHT = 1.5;

interface Candidate {
  city: CityDistance;
  route: CityRoute;
}

function weight(city: CityDistance): number {
  return (
    Math.max(city.population, 1) *
    (city.fc === "PPLC" ? CAPITAL_WEIGHT : 1) *
    (city.fc === "PPLA" ? REGIONAL_CAPITAL_WEIGHT : 1)
  );
}

function weightedPick(items: Candidate[], rng: () => number): Candidate {
  const total = items.reduce((sum, it) => sum + weight(it.city), 0);
  let r = rng() * total;
  for (const it of items) {
    r -= weight(it.city);
    if (r < 0) return it;
  }
  return items[items.length - 1]; // rng() rounding at the top edge
}

/**
 * Pick a recognizable city about `targetM` away by `profile`, weighted towards
 * bigger cities and capitals. `kind` tells the caller which case applies.
 */
export function pickCity(
  cities: CityDistance[],
  targetM: number,
  profile: Profile,
  rng: () => number = Math.random,
): CityPick {
  const pool: Candidate[] = cities
    .flatMap((city) => {
      const route = city[profile];
      return route ? [{ city, route }] : [];
    })
    .sort((a, b) => a.route.m - b.route.m || a.city.id - b.city.id);
  if (pool.length === 0) throw new Error(`No cities with a ${profile} route`);

  const nearest = pool[0];
  const farthest = pool[pool.length - 1];
  if (!(targetM > 0) || targetM < nearest.route.m * (1 - MAX_BAND))
    return { kind: "under", nearest: nearest.city, route: nearest.route };
  if (targetM > farthest.route.m * (1 + MAX_BAND))
    return { kind: "over", farthest: farthest.city, route: farthest.route };

  for (let band = BAND; band <= MAX_BAND + 1e-9; band *= 2) {
    const inBand = pool.filter(({ route }) => Math.abs(route.m - targetM) <= band * targetM);
    if (inBand.length > 0) {
      const { city, route } = weightedPick(inBand, rng);
      return { kind: "match", city, route, ratio: targetM / route.m };
    }
  }

  // In-range gap: nothing within ±MAX_BAND, so take the closest on a log scale.
  const off = (c: Candidate) => Math.abs(Math.log(c.route.m / targetM));
  const closest = pool.reduce((best, c) => (off(c) < off(best) ? c : best));
  return { kind: "match", city: closest.city, route: closest.route, ratio: targetM / closest.route.m };
}
