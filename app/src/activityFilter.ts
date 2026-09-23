// The Activity filter: which activities are shown (see CONTEXT.md). A type selection
// plus a month-stepped date range, over the activities it was created from. Pure
// module (like colors.ts / replay.ts): every change returns a new value, and the same
// rule answers both "which activities are visible" (JS) and "what does the map draw"
// (a Mapbox filter expression), so the two can't drift apart.

import type { FilterSpecification } from "mapbox-gl";
import type { ActivityFeature } from "./types";
import { monthEnd, monthIndex, monthStart } from "./format";

export interface ActivityFilter {
  /** The activities this filter was created from. */
  readonly activities: readonly ActivityFeature[];
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
}

/** A filter over `activities` with every type on and the full date range. */
export function createActivityFilter(activities: readonly ActivityFeature[]): ActivityFilter {
  const availableTypes = [...new Set(activities.map((a) => a.properties.type))].sort();
  const months = activities.map((a) => monthIndex(a.properties.ts));
  // No activities: any finite month will do, since nothing can be shown anyway.
  const minMonth = months.length ? Math.min(...months) : 0;
  const maxMonth = months.length ? Math.max(...months) : 0;
  return {
    activities,
    availableTypes,
    types: new Set(availableTypes),
    minMonth,
    maxMonth,
    fromMonth: minMonth,
    toMonth: maxMonth,
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Move the date range's start month; it can't pass the end or leave the data's months. */
export function setFromMonth(filter: ActivityFilter, month: number): ActivityFilter {
  return { ...filter, fromMonth: clamp(month, filter.minMonth, filter.toMonth) };
}

/** Move the date range's end month; it can't pass the start or leave the data's months. */
export function setToMonth(filter: ActivityFilter, month: number): ActivityFilter {
  return { ...filter, toMonth: clamp(month, filter.fromMonth, filter.maxMonth) };
}

/** Inclusive epoch-second bounds of the date range. */
function rangeTs(filter: ActivityFilter): [number, number] {
  return [monthStart(filter.fromMonth), monthEnd(filter.toMonth)];
}

function inRange(filter: ActivityFilter): (a: ActivityFeature) => boolean {
  const [from, to] = rangeTs(filter);
  return (a) => a.properties.ts >= from && a.properties.ts <= to;
}

/** The activities that pass the filter. */
export function visibleActivities(filter: ActivityFilter): ActivityFeature[] {
  const dated = inRange(filter);
  return filter.activities.filter((a) => filter.types.has(a.properties.type) && dated(a));
}

/**
 * Activities per type inside the date range. Ignores the type selection, so a type
 * that is switched off still shows how many activities turning it on would bring back.
 */
export function typeCounts(filter: ActivityFilter): Record<string, number> {
  const dated = inRange(filter);
  const counts: Record<string, number> = {};
  for (const a of filter.activities) {
    if (dated(a)) counts[a.properties.type] = (counts[a.properties.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * The same rule as visibleActivities, as a Mapbox filter expression over the `type`
 * and `ts` feature properties. An empty type selection yields an `in` over an empty
 * list, which matches nothing.
 */
export function filterExpression(filter: ActivityFilter): FilterSpecification {
  const [from, to] = rangeTs(filter);
  return [
    "all",
    ["in", ["get", "type"], ["literal", [...filter.types]]],
    [">=", ["get", "ts"], from],
    ["<=", ["get", "ts"], to],
  ];
}
