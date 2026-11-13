// The Activity filter: which activities are shown (see CONTEXT.md). A type selection,
// a month-stepped date range and at most one place, over the activities it was
// created from: every record in activities.json, with or without a route, so the map
// and the analytics page share one filter and one set of visible activities. Pure
// module (like colors.ts / replay.ts): every change returns a new value, and the same
// rule answers "which activities are visible" (JS), "which routes does the map draw"
// (JS, for the map's features) and "what does Mapbox draw" (a filter expression), so
// they can't drift apart.

import type { FilterSpecification } from "mapbox-gl";
import type { ActivityFeature, ActivityRecord } from "./types";
import { monthEnd, monthIndex, monthStart } from "./format";

export interface ActivityFilter {
  /** The activities this filter was created from. */
  readonly activities: readonly ActivityRecord[];
  /** Every activity type present, sorted. */
  readonly availableTypes: readonly string[];
  /** Type selection: the activity types switched on. Empty shows nothing. */
  readonly types: ReadonlySet<string>;
  /** Month-index bounds of the data (see format.ts: monthIndex). */
  readonly minMonth: number;
  readonly maxMonth: number;
  /** Date range, inclusive month indices. minMonth <= fromMonth <= toMonth <= maxMonth. */
  readonly fromMonth: number;
  readonly toMonth: number;
  /** The selected place (a place id, see ActivityRecord.place), or null for any. */
  readonly place: string | null;
}

/**
 * The types switched on when the page opens: the outdoor ones with a route to draw.
 * The rest (gym, swims, climbing…) are a click away in the type list.
 */
export const DEFAULT_TYPES: readonly string[] = ["Run", "Hike", "Walk", "Ride"];

/**
 * A filter over `activities` with the full date range and the default types on: those
 * of DEFAULT_TYPES the data has, or every type when it has none of them.
 */
export function createActivityFilter(activities: readonly ActivityRecord[]): ActivityFilter {
  const availableTypes = [...new Set(activities.map((a) => a.type))].sort();
  const defaults = availableTypes.filter((t) => DEFAULT_TYPES.includes(t));
  const months = activities.map((a) => monthIndex(a.ts));
  // No activities: any finite month will do, since nothing can be shown anyway.
  const minMonth = months.length ? Math.min(...months) : 0;
  const maxMonth = months.length ? Math.max(...months) : 0;
  return {
    activities,
    availableTypes,
    types: new Set(defaults.length ? defaults : availableTypes),
    minMonth,
    maxMonth,
    fromMonth: minMonth,
    toMonth: maxMonth,
    place: null,
  };
}

/** Switch an activity type on or off. A type the data doesn't contain is ignored. */
export function toggleType(filter: ActivityFilter, type: string): ActivityFilter {
  if (!filter.availableTypes.includes(type)) return filter;
  const types = new Set(filter.types);
  if (types.has(type)) types.delete(type);
  else types.add(type);
  return { ...filter, types };
}

/** Select a place, or clear it when it is the one selected. Types and dates stay. */
export function togglePlace(filter: ActivityFilter, id: string): ActivityFilter {
  return { ...filter, place: filter.place === id ? null : id };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Move the date range's start month; it can't pass the end or leave the data's months. */
export function setFromMonth(filter: ActivityFilter, month: number): ActivityFilter {
  return { ...filter, fromMonth: clamp(month, filter.minMonth, filter.toMonth) };
}

/** Move the date range's end month; it can't pass the start or leave the data's months. */
export function setToMonth(filter: ActivityFilter, month: number): ActivityFilter {
  return { ...filter, toMonth: clamp(month, filter.fromMonth, filter.maxMonth) };
}

/** Narrow the date range to one month, clamped to the data's months. */
export function onlyMonth(filter: ActivityFilter, month: number): ActivityFilter {
  const m = clamp(month, filter.minMonth, filter.maxMonth);
  return { ...filter, fromMonth: m, toMonth: m };
}

/** A month isolated with toggleMonth, and the date range it replaced. */
export interface MonthIsolation {
  readonly month: number;
  readonly fromMonth: number;
  readonly toMonth: number;
}

/** The isolation, while the range is still exactly its month; null once it moved. */
export function activeIsolation(
  filter: ActivityFilter,
  isolation: MonthIsolation | null,
): MonthIsolation | null {
  return isolation && filter.fromMonth === isolation.month && filter.toMonth === isolation.month
    ? isolation
    : null;
}

/**
 * Click on a month (a ridgeline row): isolate it with onlyMonth, remembering the range it
 * replaces. Clicking the isolated month again restores that range. The memory only
 * counts while the range is still exactly the isolated month; once the range has moved
 * some other way, a click isolates afresh. The type selection is never touched.
 */
export function toggleMonth(
  filter: ActivityFilter,
  month: number,
  isolation: MonthIsolation | null,
): [ActivityFilter, MonthIsolation | null] {
  const isolated = activeIsolation(filter, isolation);
  if (isolated && month === isolated.month) {
    return [{ ...filter, fromMonth: isolated.fromMonth, toMonth: isolated.toMonth }, null];
  }
  const next = onlyMonth(filter, month);
  const before = isolated ?? { fromMonth: filter.fromMonth, toMonth: filter.toMonth };
  return [next, { month: next.fromMonth, fromMonth: before.fromMonth, toMonth: before.toMonth }];
}

/** Inclusive epoch-second bounds of the date range. */
export function rangeTs(filter: ActivityFilter): [number, number] {
  return [monthStart(filter.fromMonth), monthEnd(filter.toMonth)];
}

function inRange(filter: ActivityFilter): (a: ActivityRecord) => boolean {
  const [from, to] = rangeTs(filter);
  return (a) => a.ts >= from && a.ts <= to;
}

function atPlace(filter: ActivityFilter): (a: ActivityRecord) => boolean {
  return (a) => filter.place === null || a.place === filter.place;
}

function passes(filter: ActivityFilter): (a: ActivityRecord) => boolean {
  const dated = inRange(filter);
  const placed = atPlace(filter);
  return (a) => filter.types.has(a.type) && dated(a) && placed(a);
}

/** Whether one activity passes the filter: the rule visibleActivities applies. */
export function isVisible(filter: ActivityFilter, a: ActivityRecord): boolean {
  return passes(filter)(a);
}

/**
 * Make one of the filter's activities visible: switch its type on, widen the date
 * range just enough to include its month, and clear the place if it has another one.
 * The same filter when the activity already passes.
 */
export function revealActivity(filter: ActivityFilter, a: ActivityRecord): ActivityFilter {
  if (isVisible(filter, a)) return filter;
  const m = monthIndex(a.ts);
  return {
    ...filter,
    types: new Set(filter.types).add(a.type),
    fromMonth: Math.min(filter.fromMonth, m),
    toMonth: Math.max(filter.toMonth, m),
    place: a.place === filter.place ? filter.place : null,
  };
}

/** revealActivity for each of `list` in turn: the narrowest widening that shows them all. */
export function revealActivities(filter: ActivityFilter, list: readonly ActivityRecord[]): ActivityFilter {
  return list.reduce(revealActivity, filter);
}

/** The activities that pass the filter. Both pages count and total these. */
export function visibleActivities(filter: ActivityFilter): ActivityRecord[] {
  return filter.activities.filter(passes(filter));
}

/** The map features (activities with a route) that pass the filter: what the map draws. */
export function visibleFeatures(
  filter: ActivityFilter,
  features: readonly ActivityFeature[],
): ActivityFeature[] {
  const pass = passes(filter);
  return features.filter((f) => pass(f.properties));
}

/**
 * Activities per type inside the date range and, when a place is selected, with that
 * place. Ignores the type selection, so a type that is switched off still shows how
 * many activities turning it on would bring back.
 */
export function typeCounts(filter: ActivityFilter): Record<string, number> {
  const dated = inRange(filter);
  const placed = atPlace(filter);
  const counts: Record<string, number> = {};
  for (const a of filter.activities) {
    if (dated(a) && placed(a)) counts[a.type] = (counts[a.type] ?? 0) + 1;
  }
  return counts;
}

/** Activities per place over all the data, whatever the filter. */
export function placeTotals(filter: ActivityFilter): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of filter.activities) {
    if (a.place !== undefined) counts[a.place] = (counts[a.place] ?? 0) + 1;
  }
  return counts;
}

/**
 * Activities per place that pass the type selection and the date range. Ignores the
 * selected place, so the other places still show what picking them would bring.
 */
export function placeCounts(filter: ActivityFilter): Record<string, number> {
  const dated = inRange(filter);
  const counts: Record<string, number> = {};
  for (const a of filter.activities) {
    if (a.place !== undefined && filter.types.has(a.type) && dated(a)) {
      counts[a.place] = (counts[a.place] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The available types, most activities first (ties by name), for listing in the
 * filter. Counted over every activity, not the date range, so the rows keep their
 * order while the range slider moves. availableTypes stays alphabetical: type colors
 * are keyed to it.
 */
export function typesByCount(filter: ActivityFilter): string[] {
  const counts: Record<string, number> = {};
  for (const a of filter.activities) counts[a.type] = (counts[a.type] ?? 0) + 1;
  return [...filter.availableTypes].sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1));
}

/** Fewest activities (over all dates) a type needs to get a row in the type list. */
export const MIN_LISTED_TYPE_ACTIVITIES = 5;

/**
 * The types the filter's type list shows: typesByCount without the rare ones (fewer
 * than MIN_LISTED_TYPE_ACTIVITIES activities), which would only clutter it.
 */
export function listedTypes(filter: ActivityFilter): string[] {
  const counts: Record<string, number> = {};
  for (const a of filter.activities) counts[a.type] = (counts[a.type] ?? 0) + 1;
  return typesByCount(filter).filter((t) => counts[t] >= MIN_LISTED_TYPE_ACTIVITIES);
}

/**
 * The same rule as visibleActivities, as a Mapbox filter expression over the `type`,
 * `ts` and (with a place selected) `place` feature properties. An empty type selection
 * yields an `in` over an empty list, which matches nothing.
 */
export function filterExpression(filter: ActivityFilter): FilterSpecification {
  const [from, to] = rangeTs(filter);
  const clauses: FilterSpecification[] = [
    ["in", ["get", "type"], ["literal", [...filter.types]]],
    [">=", ["get", "ts"], from],
    ["<=", ["get", "ts"], to],
  ];
  if (filter.place !== null) clauses.push(["==", ["get", "place"], filter.place]);
  return ["all", ...clauses];
}
