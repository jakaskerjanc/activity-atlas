// The selected activity's place and same-route group, as the detail panel's two rows
// show them (ui/GroupRows.tsx). Pure module. Both read every activity the filter was
// created from, not just the visible ones: how often you went somewhere, and the other
// times on a route, are facts about the activity, whatever the filter shows.

import { isVisible, type ActivityFilter } from "./activityFilter";
import type { ActivityRecord, Place } from "./types";

/** The place row: where the activity went, and how many activities went there. */
export interface PlaceLine {
  id: string;
  name: string;
  kind: Place["kind"];
  count: number;
}

/** The activity's place with its count over every activity, or null without a (named) place. */
export function placeLine(
  a: ActivityRecord,
  filter: ActivityFilter,
  places: ReadonlyMap<string, Place>,
): PlaceLine | null {
  const place = a.place === undefined ? undefined : places.get(a.place);
  if (!place) return null;
  const count = filter.activities.filter((x) => x.place === place.id).length;
  return { id: place.id, name: place.name, kind: place.kind, count };
}

/** One activity in the route table. */
export interface RouteRow {
  id: string;
  ts: number;
  moving_time?: number;
  /** Runs only, when both distance and moving time are known. */
  pace_s_per_km?: number;
  /** The selected activity. */
  current: boolean;
  /** The shortest moving time, when at least two rows have one. */
  fastest: boolean;
  /** Fails the filter: shown greyed, and picking it widens the filter to show it. */
  outside: boolean;
}

/** The route row and its table: the group's name and its activities, newest first. */
export interface RouteTable {
  id: string;
  name: string;
  rows: RouteRow[];
}

/**
 * The activity's same-route group, or null without a route, without a name for it in
 * places.json, or with fewer than two activities.
 */
export function routeTable(
  a: ActivityRecord,
  filter: ActivityFilter,
  routes: ReadonlyMap<string, string>,
): RouteTable | null {
  const id = a.route;
  const name = id === undefined ? undefined : routes.get(id);
  if (id === undefined || name === undefined) return null;
  const members = filter.activities
    .filter((x) => x.route === id)
    .sort((x, y) => y.ts - x.ts || (x.id < y.id ? -1 : 1));
  if (members.length < 2) return null;
  const times = members.flatMap((x) => (x.moving_time === undefined ? [] : [x.moving_time]));
  const best = times.length >= 2 ? Math.min(...times) : undefined;
  const rows = members.map((x): RouteRow => {
    const row: RouteRow = {
      id: x.id,
      ts: x.ts,
      current: x.id === a.id,
      fastest: best !== undefined && x.moving_time === best,
      outside: !isVisible(filter, x),
    };
    if (x.moving_time !== undefined) row.moving_time = x.moving_time;
    if (x.type === "Run" && x.moving_time !== undefined && x.distance !== undefined && x.distance > 0) {
      row.pace_s_per_km = x.moving_time / (x.distance / 1000);
    }
    return row;
  });
  return { id, name, rows };
}
