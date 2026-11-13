import { describe, expect, test } from "vitest";
import {
  activityMatcher,
  DEFAULT_SORT,
  highlightRanges,
  nextSort,
  searchActivities,
  searchIndex,
  sortActivities,
  type SearchNames,
} from "./activitySearch";
import { record } from "./testFixtures";
import type { Place } from "./types";

const place: Place = { id: "p1", name: "Šmarna gora", ele: 669, kind: "peak" };
const names: SearchNames = {
  places: new Map([[place.id, place]]),
  routes: new Map([["r1", "Rožnik loop"]]),
};

describe("activityMatcher", () => {
  const run = record({ id: "a", name: "Morning Run", type: "Run", place: "p1" });
  const ride = record({ id: "b", name: "Lunch ride", type: "EBikeRide", route: "r1", ts: 1700000000, start_date: "2023-11-14T22:13:20Z" });
  const matches = (q: string) => searchActivities([run, ride], q, names).map((a) => a.id);

  test("a blank query matches everything", () => {
    expect(matches("")).toEqual(["a", "b"]);
    expect(matches("   ")).toEqual(["a", "b"]);
  });

  test("finds by name, ignoring case", () => {
    expect(matches("morning")).toEqual(["a"]);
    expect(matches("LUNCH")).toEqual(["b"]);
  });

  test("finds by place and route names, ignoring accents", () => {
    expect(matches("smarna")).toEqual(["a"]);
    expect(matches("roznik")).toEqual(["b"]);
  });

  test("finds by the type, raw or as words", () => {
    expect(matches("ebikeride")).toEqual(["b"]);
    expect(matches("e-bike")).toEqual(["b"]);
  });

  test("finds by date: the year, the month, the ISO day", () => {
    // run: 2024-08-18; ride: 2023-11-14
    expect(matches("2024")).toEqual(["a"]);
    expect(matches("august")).toEqual(["a"]);
    expect(matches("nov 14")).toEqual(["b"]);
    expect(matches("2024-08-18")).toEqual(["a"]);
  });

  test("every word must match, in any field", () => {
    expect(matches("run smarna")).toEqual(["a"]);
    expect(matches("run roznik")).toEqual([]);
  });

  test("a word never spans two fields", () => {
    // name "Morning Run" then type "Run": "runrun" is in neither.
    expect(activityMatcher("runrun", searchIndex([run], names))(run)).toBe(false);
  });
});

describe("highlightRanges", () => {
  test("marks each word where it appears", () => {
    expect(highlightRanges("Morning Run", "run")).toEqual([[8, 11]]);
    expect(highlightRanges("Run, run", "run")).toEqual([
      [0, 3],
      [5, 8],
    ]);
  });

  test("maps folded matches back onto the accented original", () => {
    expect(highlightRanges("Šmarna gora", "smarna")).toEqual([[0, 6]]);
    expect(highlightRanges("Großglockner", "gross")).toEqual([[0, 4]]);
  });

  test("merges overlapping words", () => {
    expect(highlightRanges("Morning", "morn ning")).toEqual([[0, 7]]);
  });

  test("nothing for a blank query or no match", () => {
    expect(highlightRanges("Morning", "")).toEqual([]);
    expect(highlightRanges("Morning", "ride")).toEqual([]);
  });
});

describe("sortActivities", () => {
  const a = record({ id: "a", name: "beta", ts: 300, distance: 5000 });
  const b = record({ id: "b", name: "Alpha", ts: 200, distance: 12000 });
  const c = record({ id: "c", name: "gamma", ts: 100, distance: undefined });
  const ids = (key: Parameters<typeof nextSort>[1], dir: "asc" | "desc") =>
    sortActivities([c, a, b], { key, dir }).map((x) => x.id);

  test("opens newest first", () => {
    expect(sortActivities([c, a, b], DEFAULT_SORT).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("names sort case-insensitively", () => {
    expect(ids("name", "asc")).toEqual(["b", "a", "c"]);
  });

  test("unknown values go last in either direction", () => {
    expect(ids("distance", "desc")).toEqual(["b", "a", "c"]);
    expect(ids("distance", "asc")).toEqual(["a", "b", "c"]);
  });

  test("leaves its input alone", () => {
    const input = [c, a, b];
    sortActivities(input, DEFAULT_SORT);
    expect(input.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
});

describe("nextSort", () => {
  test("a new column starts in its natural direction", () => {
    expect(nextSort(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "distance")).toEqual({ key: "distance", dir: "desc" });
  });

  test("the sorted column flips", () => {
    expect(nextSort(DEFAULT_SORT, "date")).toEqual({ key: "date", dir: "asc" });
  });
});
