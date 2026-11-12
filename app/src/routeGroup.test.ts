// The selected activity's place line and same-route table: counts over every activity,
// newest first, current / fastest / outside marks, and the way back for an outside row.

import { describe, expect, test } from "vitest";
import { placeLine, routeTable } from "./routeGroup";
import {
  createActivityFilter,
  revealActivity,
  setFromMonth,
  setToMonth,
  togglePlace,
  toggleType,
  visibleActivities,
} from "./activityFilter";
import { monthIndex } from "./format";
import { record } from "./testFixtures";
import type { Place } from "./types";

const at = (iso: string) => Date.parse(iso) / 1000;

const slavnik: Place = { id: "p1", name: "Slavnik", ele: 1028, kind: "peak" };
const vrsic: Place = { id: "p2", name: "Vršič", ele: 1611, kind: "pass" };
const places = new Map([slavnik, vrsic].map((p) => [p.id, p]));
const routes = new Map([["r1", "Slavnik out-and-back via Skadanščina"], ["r2", "Park loop"]]);

const may = record({ id: "a", type: "Hike", ts: at("2025-05-03T08:00:00Z"), moving_time: 7080, place: "p1", route: "r1" });
const aug = record({ id: "b", type: "Hike", ts: at("2025-08-21T08:00:00Z"), moving_time: 7500, place: "p1", route: "r1" });
const oct = record({ id: "c", type: "Hike", ts: at("2024-10-14T08:00:00Z"), moving_time: 7920, place: "p1", route: "r1" });
const noTime = record({ id: "d", type: "Hike", ts: at("2024-06-01T08:00:00Z"), moving_time: undefined, place: "p1", route: "r1" });
const vrsicRide = record({ id: "e", type: "Ride", ts: at("2025-07-01T08:00:00Z"), place: "p2" });
const slavnikWalk = record({ id: "f", type: "Walk", ts: at("2023-01-01T08:00:00Z"), place: "p1" });
const all = [slavnikWalk, noTime, oct, may, vrsicRide, aug];

describe("placeLine", () => {
  test("placeLine counts every activity with the place, whatever the filter", () => {
    // Vršič picked and walks off: only the ride is visible, yet Slavnik counts all five.
    const filter = toggleType(togglePlace(createActivityFilter(all), "p2"), "Walk");
    expect(visibleActivities(filter).map((a) => a.id)).toEqual(["e"]);
    expect(placeLine(aug, filter, places)).toEqual({ id: "p1", name: "Slavnik", kind: "peak", count: 5 });
    expect(placeLine(vrsicRide, filter, places)).toEqual({ id: "p2", name: "Vršič", kind: "pass", count: 1 });
    // No place, or a place places.json doesn't name: no line.
    expect(placeLine(record({ id: "x" }), filter, places)).toBeNull();
    expect(placeLine(record({ id: "y", place: "p9" }), filter, places)).toBeNull();
  });
});

describe("routeTable", () => {
  test("routeTable newest first with current, fastest and outside", () => {
    // 2025 only: the two 2024 hikes fall outside the date range.
    const base = createActivityFilter(all);
    const filter = setFromMonth(base, monthIndex(at("2025-01-01T00:00:00Z")));
    const table = routeTable(aug, filter, routes);
    expect(table?.id).toBe("r1");
    expect(table?.name).toBe("Slavnik out-and-back via Skadanščina");
    expect(table?.rows.map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
    expect(table?.rows.map((r) => r.current)).toEqual([true, false, false, false]);
    expect(table?.rows.map((r) => r.fastest)).toEqual([false, true, false, false]);
    expect(table?.rows.map((r) => r.outside)).toEqual([false, false, true, true]);
    expect(table?.rows[0]).toMatchObject({ ts: aug.ts, moving_time: 7500 });
    expect(table?.rows[3].moving_time).toBeUndefined();
  });

  test("fastest needs two rows with a moving time", () => {
    const one = record({ id: "m", type: "Hike", route: "r1", moving_time: 3600 });
    const two = record({ id: "n", type: "Hike", route: "r1", moving_time: undefined });
    const table = routeTable(one, createActivityFilter([one, two]), routes);
    expect(table?.rows.map((r) => r.fastest)).toEqual([false, false]);
  });

  test("pace only for runs", () => {
    const run1 = record({ id: "r", type: "Run", route: "r2", ts: 100, distance: 10000, moving_time: 3000 });
    const run2 = record({ id: "s", type: "Run", route: "r2", ts: 200, distance: undefined, moving_time: 3100 });
    const runs = routeTable(run1, createActivityFilter([run1, run2]), routes);
    expect(runs?.rows.map((r) => r.pace_s_per_km)).toEqual([undefined, 300]);
    const walk1 = record({ id: "w", type: "Walk", route: "r2", ts: 100, distance: 4000, moving_time: 2400 });
    const walk2 = record({ id: "v", type: "Walk", route: "r2", ts: 200, distance: 4000, moving_time: 2500 });
    const walks = routeTable(walk1, createActivityFilter([walk1, walk2]), routes);
    expect(walks?.rows.map((r) => r.pace_s_per_km)).toEqual([undefined, undefined]);
  });

  test("no table for a one-off or a missing route name", () => {
    const filter = createActivityFilter(all);
    expect(routeTable(vrsicRide, filter, routes)).toBeNull();
    const lone = record({ id: "z", route: "r2" });
    expect(routeTable(lone, createActivityFilter([lone]), routes)).toBeNull();
    expect(routeTable(aug, filter, new Map())).toBeNull();
  });

  test("an outside mate in another place: reveal turns its type on, widens dates, clears the place", () => {
    // Selected: a Slavnik hike. Its route-mate is a Walk (walks off) that reached Vršič,
    // a year before the date range, and Slavnik is the picked place.
    const current = record({ id: "h", type: "Hike", ts: at("2025-06-01T08:00:00Z"), place: "p1", route: "r2" });
    const mate = record({ id: "w", type: "Walk", ts: at("2024-03-10T08:00:00Z"), place: "p2", route: "r2" });
    const other = record({ id: "o", type: "Hike", ts: at("2025-09-01T08:00:00Z"), place: "p1" });
    const june = monthIndex(current.ts);
    const base = createActivityFilter([current, mate, other]);
    const filter = setToMonth(setFromMonth(togglePlace(toggleType(base, "Walk"), "p1"), june), june);
    const table = routeTable(current, filter, routes);
    expect(table?.rows.map((r) => [r.id, r.outside])).toEqual([["h", false], ["w", true]]);

    const revealed = revealActivity(filter, mate);
    expect(revealed.types.has("Walk")).toBe(true);
    expect([revealed.fromMonth, revealed.toMonth]).toEqual([monthIndex(mate.ts), june]);
    expect(revealed.place).toBeNull();
    expect(visibleActivities(revealed)).toContain(mate);
    expect(routeTable(mate, revealed, routes)?.rows.map((r) => [r.id, r.current, r.outside])).toEqual([
      ["h", false, false],
      ["w", true, false],
    ]);
  });
});
