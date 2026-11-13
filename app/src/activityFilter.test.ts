import { describe, expect, test } from "vitest";
import { featureFilter } from "mapbox-gl/dist/style-spec/index.es.js";
import {
  createActivityFilter,
  filterExpression,
  listedTypes,
  MIN_LISTED_TYPE_ACTIVITIES,
  onlyMonth,
  placeCounts,
  placeTotals,
  isVisible,
  revealActivity,
  revealActivities,
  setFromMonth,
  setToMonth,
  toggleMonth,
  togglePlace,
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

describe("listed types", () => {
  // Enough runs to be listed, one ride short of it.
  const runs = Array.from({ length: MIN_LISTED_TYPE_ACTIVITIES }, (_, i) =>
    record({ id: `s:r${i}`, type: "Run", ts: at("2024-01-15T08:00:00Z") }),
  );
  const rides = Array.from({ length: MIN_LISTED_TYPE_ACTIVITIES - 1 }, (_, i) =>
    record({ id: `s:b${i}`, type: "Ride", ts: at("2024-03-01T00:00:00Z") }),
  );

  test("leave out types with too few activities", () => {
    expect(listedTypes(createActivityFilter([...runs, ...rides]))).toEqual(["Run"]);
  });

  test("count over every date, so a type doesn't vanish as the range narrows", () => {
    const f = setFromMonth(createActivityFilter([...runs, ...rides]), month(2024, 3));
    expect(listedTypes(f)).toEqual(["Run"]);
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

describe("place selection", () => {
  // Two places (ids are activity ids), and a run that reached none.
  const SLAVNIK = "g:100";
  const SMARNA = "g:200";
  const slavnikHike = record({ id: "g:11", type: "Hike", ts: at("2024-01-10T08:00:00Z"), place: SLAVNIK });
  const slavnikHike2 = record({ id: "g:12", type: "Hike", ts: at("2024-05-20T08:00:00Z"), place: SLAVNIK });
  const slavnikRide = record({ id: "s:13", type: "Ride", ts: at("2024-03-05T08:00:00Z"), place: SLAVNIK });
  const smarnaHike = record({ id: "g:14", type: "Hike", ts: at("2024-03-10T08:00:00Z"), place: SMARNA });
  const flatRun = record({ id: "s:15", type: "Run", ts: at("2024-02-01T08:00:00Z") });
  const smarnaRun = record({ id: "s:16", type: "Run", ts: at("2024-04-01T08:00:00Z"), place: SMARNA });
  const placed = [slavnikHike, slavnikHike2, slavnikRide, smarnaHike, flatRun, smarnaRun];
  const base = createActivityFilter(placed);

  test("togglePlace sets, then clears on the same id, and keeps types and dates", () => {
    expect(base.place).toBeNull();
    const f = toggleType(setFromMonth(base, month(2024, 2)), "Ride");
    const picked = togglePlace(f, SLAVNIK);
    expect(picked.place).toBe(SLAVNIK);
    expect(togglePlace(picked, SMARNA).place).toBe(SMARNA);
    const cleared = togglePlace(picked, SLAVNIK);
    expect(cleared.place).toBeNull();
    for (const g of [picked, cleared]) {
      expect(g.types).toBe(f.types);
      expect([g.fromMonth, g.toMonth]).toEqual([f.fromMonth, f.toMonth]);
    }
  });

  test("visibleActivities and visibleFeatures keep only the place's activities", () => {
    // Replay plays visibleFeatures, so it replays only the place's routes.
    const f = togglePlace(base, SLAVNIK);
    expect(visibleActivities(f)).toEqual([slavnikHike, slavnikHike2, slavnikRide]);
    const features = placed.map((r) => activity(r));
    expect(visibleFeatures(f, features).map((x) => x.properties.id)).toEqual(["g:11", "g:12", "s:13"]);
  });

  test("filterExpression matches visibleFeatures with a place set", () => {
    const features = placed.map((r) => activity(r));
    const filters = [
      togglePlace(base, SLAVNIK),
      togglePlace(toggleType(base, "Hike"), SMARNA),
      togglePlace(setToMonth(base, month(2024, 3)), SLAVNIK),
    ];
    for (const f of filters) {
      const drawn = featureFilter(filterExpression(f));
      const visible = new Set(visibleFeatures(f, features));
      for (const x of features) {
        const onMap = drawn.filter({ zoom: 0 }, { type: 2, properties: x.properties, geometry: [] });
        expect(onMap, `${f.place} ${x.properties.id}`).toBe(visible.has(x));
      }
    }
  });

  test("placeCounts follow types and dates but ignore the place", () => {
    expect(placeCounts(base)).toEqual({ [SLAVNIK]: 3, [SMARNA]: 2 });
    const f = toggleType(setFromMonth(base, month(2024, 2)), "Ride");
    expect(placeCounts(f)).toEqual({ [SLAVNIK]: 1, [SMARNA]: 2 });
    expect(placeCounts(togglePlace(f, SLAVNIK))).toEqual(placeCounts(f));
  });

  test("placeTotals count every activity per place, whatever the filter", () => {
    const f = togglePlace(toggleType(setFromMonth(base, month(2024, 4)), "Hike"), SMARNA);
    expect(placeTotals(f)).toEqual(placeTotals(base));
    expect(placeTotals(base)).toEqual({ [SLAVNIK]: 3, [SMARNA]: 2 });
  });

  test("typeCounts follow the place and dates but ignore the types", () => {
    const f = toggleType(togglePlace(base, SLAVNIK), "Hike");
    const counts = typeCounts(f);
    expect(counts.Hike).toBe(2);
    expect(counts.Ride).toBe(1);
    expect(counts.Run ?? 0).toBe(0);
    expect(typeCounts(setFromMonth(f, month(2024, 4)))).toEqual({ Hike: 1 });
  });

  test("a selected place outside the date range leaves nothing visible", () => {
    // February holds only the run that reached no place.
    const f = togglePlace(setToMonth(setFromMonth(base, month(2024, 2)), month(2024, 2)), SLAVNIK);
    expect(f.place).toBe(SLAVNIK);
    expect(visibleActivities(f)).toEqual([]);
    expect(visibleFeatures(f, placed.map((r) => activity(r)))).toEqual([]);
    expect(typeCounts(f)).toEqual({});
    expect(placeCounts(f)).toEqual({});
    const drawn = featureFilter(filterExpression(f));
    const onMap = (a: (typeof placed)[number]) =>
      drawn.filter({ zoom: 0 }, { type: 2, properties: a, geometry: [] });
    expect(placed.some(onMap)).toBe(false);
  });

  test("toggleMonth (the ridgeline click) keeps the place", () => {
    const f = togglePlace(base, SLAVNIK);
    const [isolated, memory] = toggleMonth(f, month(2024, 3), null);
    expect(isolated.place).toBe(SLAVNIK);
    expect(visibleActivities(isolated)).toEqual([slavnikRide]);
    const [restored] = toggleMonth(isolated, month(2024, 3), memory);
    expect(restored.place).toBe(SLAVNIK);
  });

  test("revealActivity widens dates, turns the type on, clears a different place", () => {
    // Slavnik picked, hikes off, March to April only.
    const marchToApril = setToMonth(setFromMonth(base, month(2024, 3)), month(2024, 4));
    const f = toggleType(togglePlace(marchToApril, SLAVNIK), "Hike");

    const later = revealActivity(f, slavnikHike2);
    expect(later.types.has("Hike")).toBe(true);
    expect([later.fromMonth, later.toMonth]).toEqual([month(2024, 3), month(2024, 5)]);
    expect(later.place).toBe(SLAVNIK);
    expect(visibleActivities(later)).toContain(slavnikHike2);

    const earlier = revealActivity(f, flatRun);
    expect([earlier.fromMonth, earlier.toMonth]).toEqual([month(2024, 2), month(2024, 4)]);
    expect(earlier.place).toBeNull();
    expect(earlier.types).toEqual(f.types);
    expect(visibleActivities(earlier)).toContain(flatRun);

    const elsewhere = revealActivity(f, smarnaHike);
    expect(elsewhere.place).toBeNull();
    expect([elsewhere.fromMonth, elsewhere.toMonth]).toEqual([f.fromMonth, f.toMonth]);
    expect(visibleActivities(elsewhere)).toContain(smarnaHike);
  });

  test("revealActivity returns the same filter when the activity already passes", () => {
    const f = togglePlace(base, SLAVNIK);
    expect(revealActivity(f, slavnikRide)).toBe(f);
    expect(revealActivity(base, flatRun)).toBe(base);
  });
});

describe("revealActivities", () => {
  test("widens the filter to show every one of them", () => {
    const run = record({ id: "a", type: "Run", ts: 1723975135 });
    const swim = record({ id: "b", type: "Swim", ts: 1600000000 });
    const f = revealActivities(createActivityFilter([run, swim]), [swim]);
    expect(isVisible(f, swim)).toBe(true);
    expect(isVisible(f, run)).toBe(true);
  });
});
