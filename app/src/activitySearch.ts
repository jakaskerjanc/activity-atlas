// Activity search: the Activities page's search box and sort. Pure module. A query is
// split on whitespace into words, and an activity matches when every word appears
// somewhere in its search text: its name, its type (raw and as words), the names of its
// place and same-route group, and its start date in a few spellings. Matching folds
// case and accents like the places list does (normalizeName), so "smarna" finds
// "Šmarna gora". The search texts are built once per data load (searchIndex), never per
// keystroke: building one formats dates, which is slow enough that redoing ~1,000 of
// them on every key made typing lag by a quarter of a second.

import type { ActivityRecord, Place } from "./types";
import { formatDate, typeLabel } from "./format";
import { normalizeName } from "./places";

/** Place and same-route group names by id, as App builds them from places.json. */
export interface SearchNames {
  places: ReadonlyMap<string, Place>;
  routes: ReadonlyMap<string, string>;
}

/** The query's words, folded. Empty for a blank query. */
export function queryWords(query: string): string[] {
  return normalizeName(query).split(/\s+/).filter(Boolean);
}

/**
 * Everything an activity can be found by, folded and joined: name, type, place, route
 * and date ("Aug 18, 2024", "August", "2024-08-18"). The calendar date is the local one
 * when known, like the MCP tools'; the short form is the UTC one the rest of the site shows.
 */
export function searchText(a: ActivityRecord, names: SearchNames): string {
  const parts = [a.name, a.type, typeLabel(a.type), formatDate(a.ts), longMonth(a.ts)];
  parts.push((a.start_local ?? a.start_date).slice(0, 10));
  const place = a.place !== undefined ? names.places.get(a.place) : undefined;
  if (place) parts.push(place.name);
  const route = a.route !== undefined ? names.routes.get(a.route) : undefined;
  if (route) parts.push(route);
  // Newlines between fields: a query word holds no whitespace, so it never spans two.
  return normalizeName(parts.join("\n"));
}

function longMonth(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

/** Each activity's search text by id: build once per data load, match against it per key. */
export type SearchIndex = ReadonlyMap<string, string>;

export function searchIndex(activities: readonly ActivityRecord[], names: SearchNames): SearchIndex {
  return new Map(activities.map((a) => [a.id, searchText(a, names)]));
}

/**
 * A matcher for a query over `index`: true for every activity when the query is blank,
 * false for one the index doesn't hold.
 */
export function activityMatcher(query: string, index: SearchIndex): (a: ActivityRecord) => boolean {
  const words = queryWords(query);
  if (words.length === 0) return () => true;
  return (a) => {
    const text = index.get(a.id);
    return text !== undefined && words.every((w) => text.includes(w));
  };
}

/** The activities that match a query, in the order given. */
export function searchActivities(
  activities: readonly ActivityRecord[],
  query: string,
  names: SearchNames,
): ActivityRecord[] {
  return activities.filter(activityMatcher(query, searchIndex(activities, names)));
}

/**
 * Where a query's words appear in `text` (an activity name, say), as [start, end)
 * ranges into the original string, sorted and merged. Folding can change a string's
 * length ("ß" is "ss"), so each folded character remembers which original one it came from.
 */
export function highlightRanges(text: string, query: string): [number, number][] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  let folded = "";
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = normalizeName(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
    i += ch.length;
  }
  origin.push(text.length);
  const hits: [number, number][] = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at !== -1; at = folded.indexOf(w, at + w.length)) {
      const start = origin[at];
      // The end of the last folded character's original character.
      const last = origin[at + w.length - 1];
      const end = last + (text.codePointAt(last)! > 0xffff ? 2 : 1);
      hits.push([start, end]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h[0] <= prev[1]) prev[1] = Math.max(prev[1], h[1]);
    else merged.push([h[0], h[1]]);
  }
  return merged;
}

// --- Sorting ---------------------------------------------------------------

export type SortKey = "date" | "name" | "distance" | "time" | "elevation";
export type SortDir = "asc" | "desc";
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/** Newest first: how the list opens. */
export const DEFAULT_SORT: Sort = { key: "date", dir: "desc" };

/** The direction a column sorts in when first clicked: names A–Z, numbers biggest first. */
export function firstDir(key: SortKey): SortDir {
  return key === "name" ? "asc" : "desc";
}

/** A column header click: flip the direction on the sorted column, else sort by it. */
export function nextSort(sort: Sort, key: SortKey): Sort {
  if (sort.key === key) return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstDir(key) };
}

const NUMERIC: Record<Exclude<SortKey, "name">, (a: ActivityRecord) => number | undefined> = {
  date: (a) => a.ts,
  distance: (a) => a.distance,
  time: (a) => a.moving_time,
  elevation: (a) => a.elevation_gain,
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * A sorted copy. Unknown values (no distance, say) go last in either direction, and
 * ties fall back to newest first, so the order never depends on the input's.
 */
export function sortActivities(activities: readonly ActivityRecord[], sort: Sort): ActivityRecord[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byDate = (a: ActivityRecord, b: ActivityRecord) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sort.key === "name") {
    return [...activities].sort((a, b) => sign * collator.compare(a.name, b.name) || byDate(a, b));
  }
  const value = NUMERIC[sort.key];
  return [...activities].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === undefined || vb === undefined) {
      if (va !== vb) return va === undefined ? 1 : -1;
      return byDate(a, b);
    }
    return sign * (va - vb) || byDate(a, b);
  });
}
