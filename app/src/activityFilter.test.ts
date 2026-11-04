import { describe, expect, test } from "vitest";
import { featureFilter } from "mapbox-gl/dist/style-spec/index.es.js";
import {
  createActivityFilter,
  filterExpression,
  onlyMonth,
  setFromMonth,
  setToMonth,
  toggleMonth,
  toggleType,
  typeCounts,
  typesByCount,
  visibleActivities,
  visibleFeatures,
} from "./activityFilter";
import { activity, record } from "./testFixtures";

// Epoch seconds for a UTC instant, so fixtures read as dates.
const at = (iso: string) => Date.parse(iso) / 1000;

// Month index (see format.ts: monthIndex) for a calendar month, 1-based like the ISO dates.
const month = (year: number, m: number) => year * 12 + (m - 1);

const run = record({ id: "s:1", type: "Run", ts: at("2024-01-15T08:00:00Z") });
const ride = record({ id: "s:2", type: "Ride", ts: at("2024-03-01T00:00:00Z") });
const hike = record({ id: "g:3", type: "Hike", ts: at("2024-05-31T23:59:59Z") });
const run2 = record({ id: "s:4", type: "Run", ts: at("2024-05-02T07:00:00Z") });
const all = [run, ride, hike, run2];

describe("a new activity filter", () => {
  test("shows every activity of the default types", () => {
    expect(visibleActivities(createActivityFilter(all))).toEqual(all);
  });

  test("starts with only Run, Hike, Walk and Ride on", () => {
    const swim = record({ id: "s:9", type: "Swim", ts: at("2024-02-01T07:00:00Z") });
    const walk = record({ id: "s:8", type: "Walk", ts: at("2024-02-02T07:00:00Z") });
    const f = createActivityFilter([...all, swim, walk]);
    expect([...f.types].sort()).toEqual(["Hike", "Ride", "Run", "Walk"]);
    expect(f.availableTypes).toContain("Swim");
    expect(visibleActivities(f)).not.toContain(swim);
    expect(visibleActivities(toggleType(f, "Swim"))).toContain(swim);
  });

  test("turns every type on when the data has none of the defaults", () => {
    const gym = record({ id: "g:1", type: "WeightTraining" });
    const swim = record({ id: "g:2", type: "Swim" });
    expect([...createActivityFilter([gym, swim]).types].sort()).toEqual(["Swim", "WeightTraining"]);
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

describe("types by count", () => {
  test("list the most frequent type first, ties by name", () => {
    expect(typesByCount(createActivityFilter(all))).toEqual(["Run", "Hike", "Ride"]);
  });

  test("keep their order when the date range or selection changes", () => {
    const f = toggleType(setFromMonth(createActivityFilter(all), month(2024, 4)), "Run");
    expect(typesByCount(f)).toEqual(["Run", "Hike", "Ride"]);
  });

  test("leave availableTypes alphabetical, since type colors are keyed to it", () => {
    expect(createActivityFilter(all).availableTypes).toEqual(["Hike", "Ride", "Run"]);
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
      const onMap = drawn.filter({ zoom: 0 }, { type: 2, properties: a, geometry: [] });
      expect(onMap, a.id).toBe(visible.has(a));
    }
  });
});

describe("the map's features", () => {
  // The filter is over every record; only some have a route and become map features.
  const features = [run, hike].map((r) => activity(r));

  test("are the visible activities that have a route", () => {
    const f = toggleType(createActivityFilter(all), "Hike");
    expect(visibleFeatures(f, features).map((x) => x.properties.id)).toEqual(["s:1"]);
    expect(visibleActivities(f).map((a) => a.id)).toEqual(["s:1", "s:2", "s:4"]);
  });

  test("types without a route still count and filter", () => {
    const f = createActivityFilter(all);
    expect(f.availableTypes).toContain("Ride");
    expect(typeCounts(f).Ride).toBe(1);
    expect(visibleFeatures(f, features)).toHaveLength(2);
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

describe("isolating a month", () => {
  test("onlyMonth narrows the range to that month", () => {
    const f = onlyMonth(createActivityFilter(all), month(2024, 3));
    expect([f.fromMonth, f.toMonth]).toEqual([month(2024, 3), month(2024, 3)]);
    expect(visibleActivities(f)).toEqual([ride]);
  });

  test("onlyMonth clamps to the data's months", () => {
    const f = createActivityFilter(all);
    expect(onlyMonth(f, month(2020, 1)).fromMonth).toBe(month(2024, 1));
    expect(onlyMonth(f, month(2030, 1)).toMonth).toBe(month(2024, 5));
  });

  test("a click isolates the month and keeps the type selection", () => {
    const f = toggleType(setToMonth(createActivityFilter(all), month(2024, 4)), "Ride");
    const [isolated, memory] = toggleMonth(f, month(2024, 1), null);
    expect([isolated.fromMonth, isolated.toMonth]).toEqual([month(2024, 1), month(2024, 1)]);
    expect(isolated.types).toBe(f.types);
    expect(memory).toEqual({ month: month(2024, 1), fromMonth: month(2024, 1), toMonth: month(2024, 4) });
  });

  test("a second click on the isolated month restores the range before", () => {
    const f = setFromMonth(createActivityFilter(all), month(2024, 2));
    const [isolated, memory] = toggleMonth(f, month(2024, 3), null);
    const [restored, cleared] = toggleMonth(isolated, month(2024, 3), memory);
    expect([restored.fromMonth, restored.toMonth]).toEqual([month(2024, 2), month(2024, 5)]);
    expect(cleared).toBeNull();
  });

  test("once the range moved some other way, a click isolates afresh", () => {
    const f = createActivityFilter(all);
    const [isolated, memory] = toggleMonth(f, month(2024, 3), null);
    const widened = setToMonth(isolated, month(2024, 4));
    const [again, next] = toggleMonth(widened, month(2024, 4), memory);
    expect([again.fromMonth, again.toMonth]).toEqual([month(2024, 4), month(2024, 4)]);
    expect(next).toEqual({ month: month(2024, 4), fromMonth: month(2024, 3), toMonth: month(2024, 4) });
  });
});
