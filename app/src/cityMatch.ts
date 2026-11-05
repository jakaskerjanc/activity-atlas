// Pure helpers that turn activity distance totals into a comparison city
// ("you rode X km — that's Ljubljana → Y"). No React / Mapbox deps.
// See docs/2026-09-19-distance-city-comparison-design.md.

import type { CityDistance, CityRoute } from "./cities";
import { isFootBased } from "./format";
import type { ActivityRecord, Profile } from "./types";

/** Which comparison an activity feeds; null = not a distance on the ground. */
export function activityGroup(type: string): Profile | null {
  if (/^virtual/i.test(type)) return null; // indoor trainer / treadmill
  if (/ride/i.test(type)) return "cycling";
  if (isFootBased(type)) return "walking";
  return null;
}

/**
 * Total meters per group for whatever activities the caller passes, with or without a
 * route, like the Totals card. An unknown distance counts as nothing.
 */
export function groupTotals(activities: readonly ActivityRecord[]): Record<Profile, number> {
  const totals: Record<Profile, number> = { cycling: 0, walking: 0 };
  for (const a of activities) {
    const group = activityGroup(a.type);
    if (group && a.distance != null) totals[group] += a.distance;
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

export interface CityPick {
  /**
   * match: a city about the target away (or the closest one, in a gap between cities).
   * over: the target is beyond the farthest city, which is `city`.
   * under: the target is short of the nearest city, which is `city`.
   */
  kind: "match" | "over" | "under";
  city: CityDistance;
  route: CityRoute;
  /** targetM / route.m: how much of the route the target covers */
  ratio: number;
}

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

  const result = (kind: CityPick["kind"], { city, route }: Candidate): CityPick => ({
    kind,
    city,
    route,
    ratio: targetM > 0 ? targetM / route.m : 0,
  });

  const nearest = pool[0];
  const farthest = pool[pool.length - 1];
  if (!(targetM > 0) || targetM < nearest.route.m * (1 - MAX_BAND)) return result("under", nearest);
  if (targetM > farthest.route.m * (1 + MAX_BAND)) return result("over", farthest);

  for (let band = BAND; band <= MAX_BAND + 1e-9; band *= 2) {
    const inBand = pool.filter(({ route }) => Math.abs(route.m - targetM) <= band * targetM);
    if (inBand.length > 0) return result("match", weightedPick(inBand, rng));
  }

  // In-range gap: nothing within ±MAX_BAND, so take the closest on a log scale.
  const off = (c: Candidate) => Math.abs(Math.log(c.route.m / targetM));
  return result("match", pool.reduce((best, c) => (off(c) < off(best) ? c : best)));
}

// --- Comparisons for a set of activities -------------------------------------

/** The groups, in the order they're shown. */
export const PROFILES: readonly Profile[] = ["cycling", "walking"];

/** One distance comparison: a group's total, and the city it reaches. */
export interface CityComparison {
  profile: Profile;
  /** the group's total over the activities, meters */
  totalM: number;
  pick: CityPick;
}

/**
 * A comparison per group with distance (cycling first), each picked with the seeded rng
 * so the same activities always land on the same city. A group no city has a route for
 * is left out.
 */
export function cityComparisons(
  activities: readonly ActivityRecord[],
  cities: CityDistance[],
): CityComparison[] {
  const totals = groupTotals(activities);
  return PROFILES.flatMap((profile) => {
    const totalM = totals[profile];
    if (!(totalM > 0) || !cities.some((c) => c[profile])) return [];
    return [{ profile, totalM, pick: pickCity(cities, totalM, profile, seededRng(profile, totalM)) }];
  });
}
