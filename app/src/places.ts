// Places (data/places.json): the summits, passes and tops the activities reach, and the
// rules the filter's places list, the page title and the empty-map notice follow. Pure
// module; the UI renders what it returns. Format: scripts/types.ts PlacesFile.

import type { ActivityFilter } from "./activityFilter";
import type { Place, PlacesFile } from "./types";

export const PLACES_URL = `${import.meta.env.BASE_URL}data/places.json`;

const KINDS: readonly string[] = ["peak", "pass", "top"];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

const isPlace = (p: unknown): boolean =>
  isObject(p) &&
  typeof p.id === "string" &&
  typeof p.name === "string" &&
  typeof p.ele === "number" &&
  Number.isFinite(p.ele) &&
  typeof p.kind === "string" &&
  KINDS.includes(p.kind);

const isRoute = (r: unknown): boolean =>
  isObject(r) && typeof r.id === "string" && typeof r.name === "string";

/**
 * Validate a fetched places file. Never throws: an unknown version or a bad shape
 * logs one warning and gives the empty file, so the site shows no places but loads.
 */
export function checkPlacesFile(raw: unknown): PlacesFile {
  let problem: string | null = null;
  if (!isObject(raw)) problem = "is not an object";
  else if (raw.v !== 1) problem = `has unsupported version ${String(raw.v)} (expected 1)`;
  else if (!Array.isArray(raw.places) || !raw.places.every(isPlace)) problem = "has bad places";
  else if (!Array.isArray(raw.routes) || !raw.routes.every(isRoute)) problem = "has bad routes";
  if (problem !== null) {
    console.warn(`places.json ${problem}; showing no places`);
    return { v: 1, places: [], routes: [] };
  }
  return raw as unknown as PlacesFile;
}

/** Letters NFD leaves whole, folded like the accented ones; "ß" also covers "ẞ". */
const FOLDS: Record<string, string> = { ß: "ss", ł: "l", ø: "o", đ: "d" };

/**
 * A name for matching: accents (combining marks after NFD) removed, lowercased, and
 * ß, ł, ø, đ folded ("gross" finds Großglockner). The MCP server's fold_name agrees.
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßłøđ]/g, (c) => FOLDS[c]);
}

/** Rows the places list shows before `+ N more`. */
export const PLACES_SHOWN = 8;

export interface PlaceRow {
  place: Place;
  count: number;
  selected: boolean;
}

/**
 * The places list's rows. Places with no activities (a missing key in `counts`) drop
 * out unless selected; the rest go by count, most first, then by name. A search shows
 * every match. Otherwise the first PLACES_SHOWN show (all when expanded), with the
 * selected place appended when it falls past them; `more` is how many are hidden.
 */
export function listedPlaces(
  places: readonly Place[],
  counts: Record<string, number>,
  selected: string | null,
  query: string,
  expanded: boolean,
): { rows: PlaceRow[]; more: number } {
  const all = places
    .map((place) => ({ place, count: counts[place.id] ?? 0, selected: place.id === selected }))
    .filter((row) => row.count > 0 || row.selected)
    .sort((a, b) => b.count - a.count || a.place.name.localeCompare(b.place.name, "sl"));
  const q = normalizeName(query.trim());
  if (q !== "") {
    return { rows: all.filter((row) => normalizeName(row.place.name).includes(q)), more: 0 };
  }
  if (expanded) return { rows: all, more: 0 };
  const rows = all.slice(0, PLACES_SHOWN);
  const pick = all.slice(PLACES_SHOWN).find((row) => row.selected);
  if (pick) rows.push(pick);
  return { rows, more: all.length - rows.length };
}

/** Plural labels of the types a title names; any other type reads "{type} activities". */
const TYPE_PLURALS: Record<string, string> = {
  Hike: "Hikes",
  Run: "Runs",
  Ride: "Rides",
  Walk: "Walks",
};

const selectedPlace = (filter: ActivityFilter, places: ReadonlyMap<string, Place>) =>
  filter.place === null ? undefined : places.get(filter.place);

/** "to" a peak or top, "over" a pass. */
const preposition = (place: Place) => (place.kind === "pass" ? "over" : "to");

/**
 * The page title: "Hikes to Slavnik" or "Rides over Vršič" with one type switched on,
 * "To Slavnik" / "Over Vršič" otherwise, and "All activities" without a (known) place.
 */
export function placeTitle(filter: ActivityFilter, places: ReadonlyMap<string, Place>): string {
  const place = selectedPlace(filter, places);
  if (!place) return "All activities";
  const prep = preposition(place);
  if (filter.types.size === 1) {
    const [type] = filter.types;
    const plural = Object.hasOwn(TYPE_PLURALS, type) ? TYPE_PLURALS[type] : `${type} activities`;
    return `${plural} ${prep} ${place.name}`;
  }
  return `${prep[0].toUpperCase()}${prep.slice(1)} ${place.name}`;
}

/** The notice shown when nothing is visible; with a place, it offers clearing it. */
export function emptyNotice(
  filter: ActivityFilter,
  places: ReadonlyMap<string, Place>,
): { text: string; clearPlace: boolean } {
  const place = selectedPlace(filter, places);
  if (!place) {
    return {
      text: "No activities match these filters. Switch on an activity type or widen the date range.",
      clearPlace: false,
    };
  }
  return {
    text:
      `No activities ${preposition(place)} ${place.name} match these filters. ` +
      "Switch on an activity type, widen the date range, or clear the place.",
    clearPlace: true,
  };
}
