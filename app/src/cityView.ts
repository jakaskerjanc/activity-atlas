// Display text for the distance comparisons ("your rides would take you Ljubljana →
// Lisbon"): the analytics rows and the map panel while a city route is shown. Pure, no
// React / Mapbox deps.

import type { CityComparison } from "./cityMatch";
import type { CityDistance, CityOrigin } from "./cities";
import type { StatCard } from "./stats";
import type { Profile } from "./types";

/** How each group is named: the activities, and how the route is travelled. */
export const PROFILE_TEXT: Record<Profile, { group: string; by: string }> = {
  cycling: { group: "Rides", by: "by bike" },
  walking: { group: "On foot", by: "on foot" },
};

/** meters -> "2,704" whole km, or "7.4" under 10 km so a short total isn't "7". */
export function formatTripKm(meters: number): string {
  const km = meters / 1000;
  return km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("en-US");
}

/** How much of the route a total covers: "96%", or "2.3×" from twice the route on. */
export function formatShare(ratio: number): string {
  return ratio < 1.995 ? `${Math.round(ratio * 100)}%` : `${ratio.toFixed(1)}×`;
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** ISO 3166-1 alpha-2 -> "Portugal"; the code itself if it isn't a valid one. */
export function countryName(code: string): string {
  try {
    return REGION_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Ljubljana → Lisbon" */
export function routeTitle(origin: CityOrigin, city: CityDistance): string {
  return `${origin.name} → ${city.name}`;
}

/** Said before the route when the total is short of every city, or past all of them. */
export function pickLead(c: CityComparison): string | null {
  return c.pick.kind === "under" ? "Not yet" : c.pick.kind === "over" ? "Beyond" : null;
}

/** "2,818 km by bike · Portugal · 96% of the way" */
export function comparisonDetail(c: CityComparison): string {
  const { city, route, ratio } = c.pick;
  return [
    `${formatTripKm(route.m)} km ${PROFILE_TEXT[c.profile].by}`,
    countryName(city.country),
    `${formatShare(ratio)} of the way`,
  ].join(" · ");
}

/** The map panel's subtitle while a comparison's route is shown: "By bike · Portugal". */
export function cityRouteSubtitle(c: CityComparison): string {
  const by = PROFILE_TEXT[c.profile].by;
  return `${by[0].toUpperCase()}${by.slice(1)} · ${countryName(c.pick.city.country)}`;
}

/** Great-circle distance in meters. */
function crowFliesM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The map panel's cards while a comparison's route is shown. */
export function cityCards(c: CityComparison, origin: CityOrigin): StatCard[] {
  const { city, route, ratio } = c.pick;
  return [
    { value: formatTripKm(route.m), unit: "km", label: "Route", accent: true },
    { value: formatTripKm(c.totalM), unit: "km", label: `${PROFILE_TEXT[c.profile].group} total` },
    { value: formatShare(ratio), label: "Of the way" },
    { value: formatTripKm(crowFliesM(origin, city)), unit: "km", label: "As the crow flies" },
  ];
}
