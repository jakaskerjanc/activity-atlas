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
export function toggleType(f: ActivityFilter, type: string): ActivityFilter {
  if (!f.availableTypes.includes(type)) return f;
  const types = new Set(f.types);
  if (types.has(type)) types.delete(type);
  else types.add(type);
  return { ...f, types };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Move the date range's start month; it can't pass the end or leave the data's months. */
export function setFromMonth(f: ActivityFilter, month: number): ActivityFilter {
  return { ...f, fromMonth: clamp(month, f.minMonth, f.toMonth) };
}

/** Move the date range's end month; it can't pass the start or leave the data's months. */
export function setToMonth(f: ActivityFilter, month: number): ActivityFilter {
  return { ...f, toMonth: clamp(month, f.fromMonth, f.maxMonth) };
}

/** Inclusive epoch-second bounds of the date range. */
function rangeTs(f: ActivityFilter): [number, number] {
  return [monthStart(f.fromMonth), monthEnd(f.toMonth)];
}

function inRange(f: ActivityFilter): (a: ActivityFeature) => boolean {
  const [from, to] = rangeTs(f);
  return (a) => a.properties.ts >= from && a.properties.ts <= to;
}

/** The activities that pass the filter. */
export function visibleActivities(f: ActivityFilter): ActivityFeature[] {
  const dated = inRange(f);
  return f.activities.filter((a) => f.types.has(a.properties.type) && dated(a));
}

/**
 * Activities per type inside the date range. Ignores the type selection, so a type
 * that is switched off still shows how many activities turning it on would bring back.
 */
export function typeCounts(f: ActivityFilter): Record<string, number> {
  const dated = inRange(f);
  const counts: Record<string, number> = {};
  for (const a of f.activities) {
    if (dated(a)) counts[a.properties.type] = (counts[a.properties.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * The same rule as visibleActivities, as a Mapbox filter expression over the `type`
 * and `ts` feature properties. An empty type selection yields an `in` over an empty
 * list, which matches nothing.
 */
export function filterExpression(f: ActivityFilter): FilterSpecification {
  const [from, to] = rangeTs(f);
  return [
    "all",
    ["in", ["get", "type"], ["literal", [...f.types]]],
    [">=", ["get", "ts"], from],
    ["<=", ["get", "ts"], to],
  ];
}
