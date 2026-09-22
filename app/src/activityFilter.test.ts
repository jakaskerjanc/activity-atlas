import { describe, expect, test } from "vitest";
import { featureFilter } from "mapbox-gl/dist/style-spec/index.es.js";
import {
  createActivityFilter,
  filterExpression,
  setFromMonth,
  setToMonth,
  toggleType,
  typeCounts,
  visibleActivities,
} from "./activityFilter";
import type { ActivityFeature, ActivityFeatureProps } from "./types";

function activity(props: Partial<ActivityFeatureProps>): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [] },
    properties: {
      id: "s:1",
      name: "Test",
      type: "Run",
      ts: 1723975135,
      start_date: "2024-08-18T09:58:55Z",
      distance: 10000,
      moving_time: 3000,
      elevation_gain: 100,
      ...props,
    },
  };
}

// Epoch seconds for a UTC instant, so fixtures read as dates.
const at = (iso: string) => Date.parse(iso) / 1000;

// Month index (see format.ts: monthIndex) for a calendar month, 1-based like the ISO dates.
const month = (year: number, m: number) => year * 12 + (m - 1);

const run = activity({ id: "s:1", type: "Run", ts: at("2024-01-15T08:00:00Z") });
const ride = activity({ id: "s:2", type: "Ride", ts: at("2024-03-01T00:00:00Z") });
const hike = activity({ id: "g:3", type: "Hike", ts: at("2024-05-31T23:59:59Z") });
const run2 = activity({ id: "s:4", type: "Run", ts: at("2024-05-02T07:00:00Z") });
const all = [run, ride, hike, run2];

describe("a new activity filter", () => {
  test("shows every activity", () => {
    expect(visibleActivities(createActivityFilter(all))).toEqual(all);
  });
});

describe("type selection", () => {
  test("switching a type off hides its activities", () => {
    const f = toggleType(createActivityFilter(all), "Ride");
    expect(visibleActivities(f)).toEqual([run, hike, run2]);
  });

  test("switching every type off shows nothing", () => {
    let f = createActivityFilter(all);
    for (const t of ["Run", "Ride", "Hike"]) f = toggleType(f, t);
    expect(visibleActivities(f)).toEqual([]);
  });

  test("switching a type back on restores it", () => {
    const f = createActivityFilter(all);
    expect(toggleType(toggleType(f, "Ride"), "Ride")).toEqual(f);
  });

  test("toggling a type the data doesn't contain changes nothing", () => {
    const f = createActivityFilter(all);
    expect(toggleType(f, "Swim")).toBe(f);
  });
});

describe("date range", () => {
  test("starts as the data's full month span", () => {
    const f = createActivityFilter(all);
    expect([f.fromMonth, f.toMonth]).toEqual([month(2024, 1), month(2024, 5)]);
  });

  test("includes an activity at the very first second of the start month", () => {
    const f = setToMonth(setFromMonth(createActivityFilter(all), month(2024, 3)), month(2024, 3));
    expect(visibleActivities(f)).toEqual([ride]);
  });

  test("includes an activity at the very last second of the end month", () => {
    const f = setFromMonth(createActivityFilter(all), month(2024, 4));
    expect(visibleActivities(f)).toEqual([hike, run2]);
  });

  test("a start after the end is pulled back to the end", () => {
    const f = setFromMonth(setToMonth(createActivityFilter(all), month(2024, 3)), month(2024, 5));
    expect([f.fromMonth, f.toMonth]).toEqual([month(2024, 3), month(2024, 3)]);
  });

  test("an end before the start is pulled up to the start", () => {
    const f = setToMonth(setFromMonth(createActivityFilter(all), month(2024, 3)), month(2024, 1));
    expect([f.fromMonth, f.toMonth]).toEqual([month(2024, 3), month(2024, 3)]);
  });

  test("stays within the data's months", () => {
    let f = createActivityFilter(all);
    f = setFromMonth(f, month(2020, 1));
    f = setToMonth(f, month(2030, 1));
    expect([f.fromMonth, f.toMonth]).toEqual([month(2024, 1), month(2024, 5)]);
  });
});

describe("type counts", () => {
  test("count every type across the full range", () => {
    expect(typeCounts(createActivityFilter(all))).toEqual({ Run: 2, Ride: 1, Hike: 1 });
  });

  test("still count a type that is switched off, so its row doesn't read 0", () => {
    const f = toggleType(createActivityFilter(all), "Run");
    expect(typeCounts(f)).toEqual({ Run: 2, Ride: 1, Hike: 1 });
  });

  test("only count activities inside the date range", () => {
    const f = setFromMonth(createActivityFilter(all), month(2024, 4));
    expect(typeCounts(f)).toEqual({ Run: 1, Hike: 1 });
  });
});

describe("map filter expression", () => {
  // The map draws with the expression; the panels count with visibleActivities. Run
  // the expression through Mapbox's own evaluator and require the same answer for
  // every activity, across filters that exercise each clause and each range edge.
  const base = createActivityFilter(all);
  const scenarios: [string, ReturnType<typeof createActivityFilter>][] = [
    ["new filter", base],
    ["one type off", toggleType(base, "Ride")],
    ["every type off", ["Run", "Ride", "Hike"].reduce(toggleType, base)],
    ["range on the start edge", setToMonth(setFromMonth(base, month(2024, 3)), month(2024, 3))],
    ["range on the end edge", setFromMonth(base, month(2024, 5))],
    ["range and type together", toggleType(setToMonth(base, month(2024, 3)), "Run")],
  ];

  test.each(scenarios)("draws exactly the visible activities: %s", (_, f) => {
    const drawn = featureFilter(filterExpression(f));
    const visible = new Set(visibleActivities(f));
    for (const a of all) {
      const onMap = drawn.filter({ zoom: 0 }, { type: 2, properties: a.properties, geometry: [] });
      expect(onMap, a.properties.id).toBe(visible.has(a));
    }
  });
});

describe("with no activities", () => {
  test("shows and counts nothing", () => {
    const f = createActivityFilter([]);
    expect(visibleActivities(f)).toEqual([]);
    expect(typeCounts(f)).toEqual({});
    expect(f.availableTypes).toEqual([]);
  });

  test("still has a finite date range for the slider", () => {
    const f = createActivityFilter([]);
    expect([f.minMonth, f.maxMonth, f.fromMonth, f.toMonth].every(Number.isFinite)).toBe(true);
  });
});
