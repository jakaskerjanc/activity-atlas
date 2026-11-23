import { describe, expect, test } from "vitest";
import { gapLabel, groupTitle, listItems, periodKey, totalsLabel, type ListItem } from "./activityGroups";
import { DEFAULT_SORT, sortActivities } from "./activitySearch";
import { record } from "./testFixtures";

const at = (iso: string) => Date.parse(iso) / 1000;
const a = (id: string, iso: string, more: Parameters<typeof record>[0] = {}) => record({ id, ts: at(iso), ...more });

/** The items as short strings: "h:<title>", "g:<periods>", or the row's id. */
const shape = (items: ListItem[]) =>
  items.map((it) => (it.kind === "row" ? it.activity.id : it.kind === "header" ? `h:${groupTitle(it)}` : `g:${it.periods}`));

describe("periodKey", () => {
  test("weeks start on Monday (UTC), across a month and a year end", () => {
    // Mon Dec 29, 2025 .. Sun Jan 4, 2026 is one week.
    const monday = periodKey(at("2025-12-29T00:00:00Z"), "week");
    expect(periodKey(at("2026-01-04T23:59:59Z"), "week")).toBe(monday);
    expect(periodKey(at("2026-01-05T00:00:00Z"), "week")).toBe(monday + 7);
    expect(periodKey(at("2025-12-28T23:59:59Z"), "week")).toBe(monday - 7);
  });

  test("months are the UTC calendar month the row's date shows", () => {
    expect(periodKey(at("2026-11-30T23:59:59Z"), "month")).toBe(2026 * 12 + 10);
    expect(periodKey(at("2026-12-01T00:00:00Z"), "month")).toBe(2026 * 12 + 11);
  });
});

describe("listItems", () => {
  const nov21 = a("nov21", "2026-11-21T08:00:00Z", { distance: 11_200, moving_time: 3730, elevation_gain: 410 });
  const nov19 = a("nov19", "2026-11-19T17:00:00Z", { distance: 34_000, moving_time: 4540, elevation_gain: 280 });
  const oct02 = a("oct02", "2026-10-02T08:00:00Z", { distance: 5_000, moving_time: 1800, elevation_gain: 20 });
  const jun10 = a("jun10", "2026-06-10T08:00:00Z", { distance: 8_000, moving_time: 2400, elevation_gain: 90 });
  const newestFirst = sortActivities([oct02, nov19, jun10, nov21], DEFAULT_SORT);

  test("ungrouped, just the rows in the order given", () => {
    const items = listItems(newestFirst, "none", DEFAULT_SORT);
    expect(shape(items)).toEqual(["nov21", "nov19", "oct02", "jun10"]);
    expect(items.map((it) => it.kind === "row" && it.row)).toEqual([0, 1, 2, 3]);
  });

  test("by month: a header per month with its subtotals, and one line for the months between", () => {
    const items = listItems(newestFirst, "month", DEFAULT_SORT);
    expect(shape(items)).toEqual([
      "h:November 2026",
      "nov21",
      "nov19",
      "h:October 2026",
      "oct02",
      "g:3", // July, August, September
      "h:June 2026",
      "jun10",
    ]);
    const nov = items[0];
    expect(nov.kind === "header" && nov.totals).toEqual({ count: 2, distance: 45_200, time: 8270, climb: 690 });
    // Rows keep counting across the headers.
    expect(items.filter((it) => it.kind === "row").map((it) => it.kind === "row" && it.row)).toEqual([0, 1, 2, 3]);
  });

  test("by week: titled by the Monday, with no line between adjacent weeks", () => {
    const sun = a("sun", "2026-11-22T10:00:00Z");
    const mon = a("mon", "2026-11-23T10:00:00Z");
    const earlier = a("earlier", "2026-11-03T10:00:00Z");
    const items = listItems(sortActivities([sun, mon, earlier], DEFAULT_SORT), "week", DEFAULT_SORT);
    expect(shape(items)).toEqual([
      "h:Week of Nov 23, 2026",
      "mon",
      "h:Week of Nov 16, 2026",
      "sun",
      "g:1", // the week of Nov 9
      "h:Week of Nov 2, 2026",
      "earlier",
    ]);
  });

  test("a non-date sort sorts inside each group; the groups stay newest first", () => {
    const sort = { key: "distance", dir: "desc" } as const;
    const items = listItems(sortActivities([oct02, nov21, jun10, nov19], sort), "month", sort);
    expect(shape(items)).toEqual(["h:November 2026", "nov19", "nov21", "h:October 2026", "oct02", "g:3", "h:June 2026", "jun10"]);
  });

  test("oldest first puts the oldest group first", () => {
    const sort = { key: "date", dir: "asc" } as const;
    const items = listItems(sortActivities(newestFirst, sort), "month", sort);
    expect(shape(items)).toEqual(["h:June 2026", "jun10", "g:3", "h:October 2026", "oct02", "h:November 2026", "nov19", "nov21"]);
  });

  test("subtotals leave unknown values out", () => {
    const gym = a("gym", "2026-11-20T08:00:00Z", { distance: undefined, moving_time: 3600, elevation_gain: undefined });
    const items = listItems(sortActivities([nov21, gym], DEFAULT_SORT), "month", DEFAULT_SORT);
    expect(items[0].kind === "header" && items[0].totals).toEqual({ count: 2, distance: 11_200, time: 7330, climb: 410 });
  });

  test("nothing listed, nothing drawn", () => {
    expect(listItems([], "week", DEFAULT_SORT)).toEqual([]);
  });
});

describe("labels", () => {
  test("totals: count, km, moving time and climb, leaving out what adds to nothing", () => {
    expect(totalsLabel({ count: 12, distance: 98_400, time: 42_000, climb: 2310 })).toBe("12 activities · 98 km · 11h 40m · 2,310 m");
    expect(totalsLabel({ count: 1, distance: 4_250, time: 1500, climb: 0 })).toBe("1 activity · 4.3 km · 25m");
    expect(totalsLabel({ count: 3, distance: 0, time: 5400, climb: 0 })).toBe("3 activities · 1h 30m");
  });

  test("gap lines count the empty weeks or months, and say matches while searching", () => {
    expect(gapLabel({ kind: "gap", key: 0, grouping: "week", periods: 2 }, false)).toBe("2 weeks without activities");
    expect(gapLabel({ kind: "gap", key: 0, grouping: "month", periods: 1 }, false)).toBe("1 month without activities");
    expect(gapLabel({ kind: "gap", key: 0, grouping: "month", periods: 4 }, true)).toBe("4 months without matches");
  });
});
