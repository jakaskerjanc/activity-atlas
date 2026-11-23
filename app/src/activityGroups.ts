// Activity grouping: the Activities page's Group choice, which reads the list like a
// training log. Pure module. The listed activities (searched and sorted) are split into
// calendar weeks (from Monday) or months of the date their row shows (UTC, formatDate),
// each under a group header with its subtotals, and a stretch of empty weeks or months
// between two groups becomes one gap line. The rows keep their order inside a group, so
// the sort applies there ("longest run of each month"); the groups themselves go newest
// first unless the sort is oldest first. The result is the virtualized list's items.

import type { ActivityRecord } from "./types";
import type { Sort } from "./activitySearch";
import { formatDate, formatDuration, formatKm, formatMeters, formatMonth, monthIndex } from "./format";

export type Grouping = "none" | "week" | "month";

/** How the list opens: one list, no headers. */
export const DEFAULT_GROUPING: Grouping = "none";

/** A group's sums over its activities; unknown values are left out (never taken as 0). */
export interface GroupTotals {
  count: number;
  /** meters */
  distance: number;
  /** moving time, seconds */
  time: number;
  /** elevation gain, meters */
  climb: number;
}

export type ListItem =
  /** `row`: the activity's place among the rows only, for keyboard steps and aria-posinset. */
  | { kind: "row"; activity: ActivityRecord; row: number }
  /** `key`: the group's periodKey. */
  | { kind: "header"; key: number; grouping: "week" | "month"; totals: GroupTotals }
  /** `key`: the periodKey of the group above it; `periods`: how many weeks or months it stands for. */
  | { kind: "gap"; key: number; grouping: "week" | "month"; periods: number };

const DAY = 86_400;

/**
 * The period an activity starting at `ts` (epoch seconds) falls in: for a week, its
 * Monday as a UTC day number (days since Jan 1, 1970, a Thursday); for a month, its
 * month index (format.ts: monthIndex).
 */
export function periodKey(ts: number, grouping: "week" | "month"): number {
  if (grouping === "month") return monthIndex(ts);
  const day = Math.floor(ts / DAY);
  return day - (((day + 3) % 7) + 7) % 7;
}

/** Periods strictly between two keys: weeks are 7 days apart, months 1. */
const periodsBetween = (a: number, b: number, grouping: "week" | "month") =>
  Math.abs(a - b) / (grouping === "week" ? 7 : 1) - 1;

/**
 * The list's items: just the rows for "none"; otherwise each group's header, then its
 * rows in the order given, with a gap item between two groups that aren't adjacent.
 */
export function listItems(sorted: readonly ActivityRecord[], grouping: Grouping, sort: Sort): ListItem[] {
  if (grouping === "none") return sorted.map((activity, row) => ({ kind: "row", activity, row }));
  const groups = new Map<number, ActivityRecord[]>();
  for (const a of sorted) {
    const key = periodKey(a.ts, grouping);
    const group = groups.get(key);
    if (group) group.push(a);
    else groups.set(key, [a]);
  }
  const oldestFirst = sort.key === "date" && sort.dir === "asc";
  const keys = [...groups.keys()].sort((a, b) => (oldestFirst ? a - b : b - a));
  const items: ListItem[] = [];
  let row = 0;
  keys.forEach((key, i) => {
    if (i > 0) {
      const periods = periodsBetween(keys[i - 1], key, grouping);
      if (periods > 0) items.push({ kind: "gap", key: keys[i - 1], grouping, periods });
    }
    const group = groups.get(key)!;
    items.push({ kind: "header", key, grouping, totals: totals(group) });
    for (const activity of group) items.push({ kind: "row", activity, row: row++ });
  });
  return items;
}

function totals(group: readonly ActivityRecord[]): GroupTotals {
  const t: GroupTotals = { count: group.length, distance: 0, time: 0, climb: 0 };
  for (const a of group) {
    t.distance += a.distance ?? 0;
    t.time += a.moving_time ?? 0;
    t.climb += a.elevation_gain ?? 0;
  }
  return t;
}

/** "Week of Nov 17, 2026" (its Monday, in the rows' date format) or "November 2026". */
export function groupTitle(header: Extract<ListItem, { kind: "header" }>): string {
  return header.grouping === "month" ? formatMonth(header.key) : `Week of ${formatDate(header.key * DAY)}`;
}

/**
 * "12 activities · 98 km · 11h 40m · 2,310 m": a sum that comes to nothing (a gym week's
 * distance) is left out. Whole km from 10 km up, one decimal below.
 */
export function totalsLabel(t: GroupTotals): string {
  const parts = [`${t.count.toLocaleString("en-US")} ${t.count === 1 ? "activity" : "activities"}`];
  if (t.distance > 0) parts.push(`${formatKm(t.distance, t.distance < 10_000 ? 1 : 0)} km`);
  if (t.time > 0) parts.push(formatDuration(t.time));
  if (t.climb > 0) parts.push(`${formatMeters(t.climb)} m`);
  return parts.join(" · ");
}

/** "2 weeks without activities"; while searching, "… without matches". */
export function gapLabel(gap: Extract<ListItem, { kind: "gap" }>, searching: boolean): string {
  const unit = gap.periods === 1 ? gap.grouping : `${gap.grouping}s`;
  return `${gap.periods} ${unit} without ${searching ? "matches" : "activities"}`;
}
