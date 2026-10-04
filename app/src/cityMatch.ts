// Pure helpers that turn activity distance totals into a comparison city
// ("you rode X km — that's Ljubljana → Y"). No React / Mapbox deps.
// See docs/2026-09-19-distance-city-comparison-design.md.

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
