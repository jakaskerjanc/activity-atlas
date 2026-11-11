import { afterEach, describe, expect, test, vi } from "vitest";
import { createActivityFilter, type ActivityFilter } from "./activityFilter";
import {
  checkPlacesFile,
  emptyNotice,
  listedPlaces,
  normalizeName,
  PLACES_SHOWN,
  PLACES_URL,
  placeTitle,
} from "./places";
import { record } from "./testFixtures";
import type { Place } from "./types";

const place = (id: string, name: string, kind: Place["kind"] = "peak"): Place => ({
  id,
  name,
  ele: 1000,
  kind,
});

const slavnik = place("p:1", "Slavnik");
const vrsic = place("p:2", "Vršič", "pass");
const smarna = place("p:3", "Šmarna gora");
const top = place("p:4", "Top at 812 m", "top");
const byId = new Map([slavnik, vrsic, smarna, top].map((p) => [p.id, p]));

const names = (r: ReturnType<typeof listedPlaces>) => r.rows.map((row) => row.place.name);

// A filter over a few activities of every type the tests name, with `types` switched on.
const base = createActivityFilter(
  ["Hike", "Ride", "Run", "Walk", "WeightTraining"].map((type, i) =>
    record({ id: `s:${i}`, type }),
  ),
);
const filterWith = (types: string[], place: string | null): ActivityFilter => ({
  ...base,
  types: new Set(types),
  place,
});

test("PLACES_URL points at data/places.json under the base URL", () => {
  expect(PLACES_URL).toBe(`${import.meta.env.BASE_URL}data/places.json`);
});

test("normalizeName drops accents and case", () => {
  expect(normalizeName("Šmarna GORA")).toBe("smarna gora");
  expect(normalizeName("Vršič")).toBe("vrsic");
});

test("normalizeName folds the letters NFD leaves whole: ß, ł, ø, đ", () => {
  expect(normalizeName("Großglockner")).toBe("grossglockner");
  expect(normalizeName("GROẞGLOCKNER")).toBe("grossglockner");
  expect(normalizeName("Łysica")).toBe("lysica");
  expect(normalizeName("Snøhetta")).toBe("snohetta");
  expect(normalizeName("ØRESUND")).toBe("oresund");
  expect(normalizeName("Đurđevac")).toBe("durdevac");
});

test("a search for the folded spelling finds the place", () => {
  const gross = place("p:gross", "Großglockner");
  const lysica = place("p:lysica", "Łysica");
  const counts = { [gross.id]: 1, [lysica.id]: 1 };
  expect(listedPlaces([gross, lysica], counts, null, "gross", false).rows.map((r) => r.place.name)).toEqual([
    "Großglockner",
  ]);
  expect(listedPlaces([gross, lysica], counts, null, "lysica", false).rows.map((r) => r.place.name)).toEqual([
    "Łysica",
  ]);
});

describe("the places list", () => {
  const ps = [slavnik, vrsic, smarna, top];
  const c = { [slavnik.id]: 5, [vrsic.id]: 3, [smarna.id]: 2, [top.id]: 1 };

  test("search ignores case and accents both ways", () => {
    for (const q of ["smarna", "ŠMARNA", "šmarna"]) {
      expect(names(listedPlaces(ps, c, null, q, false))).toEqual(["Šmarna gora"]);
    }
    expect(names(listedPlaces(ps, c, null, "Vršič", false))).toEqual(["Vršič"]);
    expect(names(listedPlaces(ps, c, null, "vrsic", false))).toEqual(["Vršič"]);
  });

  // Twelve places: counts 12..1, except two ties at 6 to check the name order, which
  // follows Slovenian collation (Č after C, before D), not code points.
  const many = Array.from({ length: 12 }, (_, i) =>
    place(`m:${i}`, `Peak ${String(i).padStart(2, "0")}`),
  );
  many[6] = place("m:6", "Dobrča");
  many[7] = place("m:7", "Čaven");
  const manyCounts: Record<string, number> = Object.fromEntries(
    many.map((p, i) => [p.id, 12 - i]),
  );
  manyCounts["m:7"] = 6;

  test("first 8 by count then name, more counts the rest", () => {
    const listed = listedPlaces(many, manyCounts, null, "", false);
    expect(listed.rows).toHaveLength(PLACES_SHOWN);
    expect(names(listed)).toEqual([
      "Peak 00",
      "Peak 01",
      "Peak 02",
      "Peak 03",
      "Peak 04",
      "Peak 05",
      "Čaven",
      "Dobrča",
    ]);
    expect(listed.rows.map((r) => r.count)).toEqual([12, 11, 10, 9, 8, 7, 6, 6]);
    expect(listed.more).toBe(4);

    const expanded = listedPlaces(many, manyCounts, null, "", true);
    expect(expanded.rows).toHaveLength(12);
    expect(expanded.more).toBe(0);
  });

  test("a search shows every match, past the first 8", () => {
    const listed = listedPlaces(many, manyCounts, null, "peak", false);
    expect(listed.rows).toHaveLength(10);
    expect(listed.more).toBe(0);
  });

  test("zero-count places drop out, the selected one stays with 0", () => {
    const counts = { [slavnik.id]: 2 };
    expect(names(listedPlaces(ps, counts, null, "", false))).toEqual(["Slavnik"]);

    const listed = listedPlaces(ps, counts, vrsic.id, "", false);
    expect(listed.rows).toEqual([
      { place: slavnik, count: 2, selected: false },
      { place: vrsic, count: 0, selected: true },
    ]);
    expect(listed.more).toBe(0);
    // A search still finds it.
    expect(names(listedPlaces(ps, counts, vrsic.id, "vrš", false))).toEqual(["Vršič"]);
  });

  test("a selected place past the first 8 is still shown", () => {
    const listed = listedPlaces(many, manyCounts, "m:11", "", false);
    expect(listed.rows).toHaveLength(PLACES_SHOWN + 1);
    expect(listed.rows.at(-1)).toEqual({ place: many[11], count: 1, selected: true });
    expect(listed.rows.filter((r) => r.selected)).toHaveLength(1);
    expect(listed.more).toBe(3);
  });

  test("a selected place among the first 8 is marked in place", () => {
    const listed = listedPlaces(many, manyCounts, "m:1", "", false);
    expect(listed.rows).toHaveLength(PLACES_SHOWN);
    expect(listed.rows[1]).toEqual({ place: many[1], count: 11, selected: true });
    expect(listed.more).toBe(4);
  });
});

test("titles", () => {
  expect(placeTitle(filterWith(["Hike"], slavnik.id), byId)).toBe("Hikes to Slavnik");
  expect(placeTitle(filterWith(["Run"], top.id), byId)).toBe("Runs to Top at 812 m");
  expect(placeTitle(filterWith(["Walk"], smarna.id), byId)).toBe("Walks to Šmarna gora");
  expect(placeTitle(filterWith(["Ride"], vrsic.id), byId)).toBe("Rides over Vršič");
  expect(placeTitle(filterWith(["Hike", "Ride"], slavnik.id), byId)).toBe("To Slavnik");
  expect(placeTitle(filterWith(["Hike", "Ride"], vrsic.id), byId)).toBe("Over Vršič");
  expect(placeTitle(filterWith([], slavnik.id), byId)).toBe("To Slavnik");
  expect(placeTitle(filterWith(["WeightTraining"], top.id), byId)).toBe(
    "WeightTraining activities to Top at 812 m",
  );
  // A type named like an Object.prototype key is still just a type.
  expect(placeTitle(filterWith(["constructor"], slavnik.id), byId)).toBe("constructor activities to Slavnik");
  expect(placeTitle(filterWith(["toString"], vrsic.id), byId)).toBe("toString activities over Vršič");
  expect(placeTitle(filterWith(["Hike"], null), byId)).toBe("All activities");
  expect(placeTitle(filterWith(["Hike"], "p:missing"), byId)).toBe("All activities");
});

describe("checkPlacesFile", () => {
  afterEach(() => vi.restoreAllMocks());

  const good = {
    v: 1,
    places: [slavnik, vrsic],
    routes: [{ id: "r:1", name: "Slavnik from Podgorje" }],
  };
  const empty = { v: 1, places: [], routes: [] };

  test("a version 1 file passes through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkPlacesFile(good)).toEqual(good);
    expect(warn).not.toHaveBeenCalled();
  });

  test("an unknown places.json version degrades to no places", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkPlacesFile({ ...good, v: 2 })).toEqual(empty);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["null", null],
    ["a string", "places"],
    ["no places array", { v: 1, routes: [] }],
    ["no routes array", { v: 1, places: [] }],
    ["a place without a name", { v: 1, places: [{ id: "p:1", ele: 1, kind: "peak" }], routes: [] }],
    ["a place of an unknown kind", { v: 1, places: [{ ...slavnik, kind: "hill" }], routes: [] }],
    ["a place with a non-numeric ele", { v: 1, places: [{ ...slavnik, ele: "1028" }], routes: [] }],
    ["a null place", { v: 1, places: [null], routes: [] }],
    ["a route without an id", { v: 1, places: [], routes: [{ name: "x" }] }],
  ])("a bad shape (%s) degrades to no places", (_, raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkPlacesFile(raw)).toEqual(empty);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

test("the empty notice names the selected place and offers clearing it", () => {
  expect(emptyNotice(filterWith(["Hike"], slavnik.id), byId)).toEqual({
    text: "No activities to Slavnik match these filters. Switch on an activity type, widen the date range, or clear the place.",
    clearPlace: true,
  });
  expect(emptyNotice(filterWith(["Ride"], vrsic.id), byId)).toEqual({
    text: "No activities over Vršič match these filters. Switch on an activity type, widen the date range, or clear the place.",
    clearPlace: true,
  });
  const today = {
    text: "No activities match these filters. Switch on an activity type or widen the date range.",
    clearPlace: false,
  };
  expect(emptyNotice(filterWith(["Hike"], null), byId)).toEqual(today);
  expect(emptyNotice(filterWith(["Hike"], "p:missing"), byId)).toEqual(today);
});
