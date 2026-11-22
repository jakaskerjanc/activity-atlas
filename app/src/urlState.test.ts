import { describe, expect, test } from "vitest";
import {
  createActivityFilter,
  setFromMonth,
  setToMonth,
  toggleType,
  togglePlace,
  type ActivityFilter,
} from "./activityFilter";
import {
  filterFromUrl,
  formatUrlState,
  parseUrlState,
  sameCamera,
  selectionFromUrl,
  urlStateOf,
  type AppUrlState,
  type UrlState,
} from "./urlState";
import { record } from "./testFixtures";

// Epoch seconds for a UTC instant, so fixtures read as dates.
const at = (iso: string) => Date.parse(iso) / 1000;
// Month index (see format.ts: monthIndex) for a calendar month, 1-based like the ISO dates.
const month = (year: number, m: number) => year * 12 + (m - 1);

const run = record({ id: "s:1", type: "Run", ts: at("2023-01-15T08:00:00Z"), place: "p1", route: "r1" });
const ride = record({ id: "s:2", type: "Ride", ts: at("2023-06-01T00:00:00Z") });
const swim = record({ id: "g:3", type: "Swim", ts: at("2024-03-31T23:59:59Z") });
const run2 = record({ id: "s:4", type: "Run", ts: at("2024-05-02T07:00:00Z"), place: "p1", route: "r1" });
const all = [run, ride, swim, run2];
const PLACES = new Set(["p1", "p2"]);

const fresh = () => createActivityFilter(all);

/** The app state with everything at its default. */
const defaults = (filter: ActivityFilter = fresh()): AppUrlState => ({
  filter,
  selectedId: null,
  groupOpen: false,
  colorMode: "uniform",
  camera: null,
});

/** App state -> URL search -> app state, as a reload does it. */
function reload(app: AppUrlState) {
  const search = formatUrlState(urlStateOf(app));
  const state = parseUrlState(search);
  const filter = filterFromUrl(createActivityFilter(app.filter.activities), state, PLACES);
  return { search, state, filter, selection: selectionFromUrl(state, filter) };
}

/** The parts of a filter the URL carries. */
const shape = (f: ActivityFilter) => ({
  types: [...f.types].sort(),
  fromMonth: f.fromMonth,
  toMonth: f.toMonth,
  place: f.place,
});

describe("the default state", () => {
  test("is the bare URL", () => {
    expect(formatUrlState(urlStateOf(defaults()))).toBe("");
  });

  test("parses from an empty search, a bare ? or an old page-only URL", () => {
    expect(parseUrlState("")).toEqual({});
    expect(parseUrlState("?")).toEqual({});
  });

  test("an empty URL state leaves a new filter as it is", () => {
    expect(filterFromUrl(fresh(), {}, PLACES)).toEqual(fresh());
    expect(selectionFromUrl({}, fresh())).toEqual({ selectedId: null, groupRoute: null });
  });

  test("the default types in another order are still the default", () => {
    const f = toggleType(toggleType(fresh(), "Run"), "Run");
    expect(formatUrlState(urlStateOf(defaults(f)))).toBe("");
  });

  test("a date range back at the data's span is not written", () => {
    const f = setFromMonth(setFromMonth(fresh(), month(2023, 6)), month(2023, 1));
    expect(formatUrlState(urlStateOf(defaults(f)))).toBe("");
  });
});

describe("round trips", () => {
  test("a type selection", () => {
    const f = toggleType(toggleType(fresh(), "Swim"), "Ride");
    const r = reload(defaults(f));
    expect(r.search).toBe("?types=Run,Swim");
    expect(shape(r.filter)).toEqual(shape(f));
  });

  test("an empty type selection", () => {
    const f = toggleType(toggleType(fresh(), "Run"), "Ride");
    const r = reload(defaults(f));
    expect(r.search).toBe("?types=");
    expect(r.filter.types.size).toBe(0);
  });

  test("a date range, each end on its own", () => {
    const both = setToMonth(setFromMonth(fresh(), month(2023, 6)), month(2024, 3));
    expect(reload(defaults(both)).search).toBe("?from=2023-06&to=2024-03");
    expect(shape(reload(defaults(both)).filter)).toEqual(shape(both));
    const start = setFromMonth(fresh(), month(2023, 6));
    expect(reload(defaults(start)).search).toBe("?from=2023-06");
    expect(shape(reload(defaults(start)).filter)).toEqual(shape(start));
  });

  test("a place", () => {
    const f = togglePlace(fresh(), "p1");
    const r = reload(defaults(f));
    expect(r.search).toBe("?place=p1");
    expect(r.filter.place).toBe("p1");
  });

  test("a selected activity with its same-route group open", () => {
    const r = reload({ ...defaults(), selectedId: "s:4", groupOpen: true });
    expect(r.search).toBe("?activity=s:4&group=1");
    expect(r.selection).toEqual({ selectedId: "s:4", groupRoute: "r1" });
  });

  test("a selected activity with its group shut", () => {
    const r = reload({ ...defaults(), selectedId: "s:2" });
    expect(r.search).toBe("?activity=s:2");
    expect(r.selection).toEqual({ selectedId: "s:2", groupRoute: null });
  });

  test("a color mode", () => {
    const r = reload({ ...defaults(), colorMode: "grade" });
    expect(r.search).toBe("?color=grade");
    expect(r.state.color).toBe("grade");
  });

  test("a camera, at URL precision, zoom/lat/lng", () => {
    const camera = { center: [14.505812345, 46.056912345] as [number, number], zoom: 12.4049 };
    const r = reload({ ...defaults(), camera });
    expect(r.search).toBe("?map=12.40/46.05691/14.50581");
    expect(r.state.camera).toEqual({ center: [14.50581, 46.05691], zoom: 12.4 });
    expect(sameCamera(r.state.camera!, camera)).toBe(true);
  });

  test("everything at once, in a fixed key order", () => {
    const f = togglePlace(setFromMonth(toggleType(fresh(), "Swim"), month(2023, 6)), "p1");
    const app: AppUrlState = {
      filter: f,
      selectedId: "s:1",
      groupOpen: true,
      colorMode: "type",
      camera: { center: [14.5, 46], zoom: 9 },
    };
    const r = reload(app);
    expect(r.search).toBe(
      "?types=Ride,Run,Swim&from=2023-06&place=p1&activity=s:1&group=1&color=type&map=9.00/46.00000/14.50000",
    );
    expect(shape(r.filter)).toEqual(shape(f));
    expect(r.selection).toEqual({ selectedId: "s:1", groupRoute: "r1" });
    expect(r.state.color).toBe("type");
    expect(r.state.camera).toEqual(app.camera);
  });
});

describe("writing", () => {
  test("an open group without a selected activity is not written", () => {
    expect(formatUrlState(urlStateOf({ ...defaults(), groupOpen: true }))).toBe("");
  });

  test("values are escaped, but commas and slashes stay readable", () => {
    const state: UrlState = { place: "a b&c=d", types: ["A/B", "C"] };
    const search = formatUrlState(state);
    expect(search).toBe("?types=A/B,C&place=a%20b%26c%3Dd");
    expect(parseUrlState(search)).toEqual(state);
  });
});

describe("invalid or stale input falls back to the defaults", () => {
  test("types the data no longer has are dropped", () => {
    const f = filterFromUrl(fresh(), parseUrlState("?types=Run,Kayak"), PLACES);
    expect([...f.types]).toEqual(["Run"]);
  });

  test("a type list with no type the data has is the default selection", () => {
    const f = filterFromUrl(fresh(), parseUrlState("?types=Kayak,Canoe"), PLACES);
    expect(shape(f)).toEqual(shape(fresh()));
  });

  test("a place that no longer exists is no place", () => {
    expect(filterFromUrl(fresh(), parseUrlState("?place=gone"), PLACES).place).toBeNull();
  });

  test("an activity that no longer exists selects nothing, and opens no group", () => {
    expect(selectionFromUrl(parseUrlState("?activity=gone&group=1"), fresh())).toEqual({
      selectedId: null,
      groupRoute: null,
    });
  });

  test("a group flag on an activity without a same-route group opens nothing", () => {
    expect(selectionFromUrl(parseUrlState("?activity=s:2&group=1"), fresh())).toEqual({
      selectedId: "s:2",
      groupRoute: null,
    });
  });

  test("a group flag other than 1 is ignored", () => {
    expect(parseUrlState("?activity=s:1&group=yes").group).toBeUndefined();
  });

  test("malformed months are dropped", () => {
    for (const bad of ["2023-13", "2023-00", "2023-1", "23-01", "2023-01x", "", "nope"]) {
      expect(parseUrlState(`?from=${bad}&to=${bad}`)).toEqual({});
    }
  });

  test("months outside the data are pulled into its span", () => {
    const f = filterFromUrl(fresh(), parseUrlState("?from=2010-01&to=2030-12"), PLACES);
    expect(shape(f)).toEqual(shape(fresh()));
  });

  test("a start after the end drops both", () => {
    const f = filterFromUrl(fresh(), parseUrlState("?from=2024-03&to=2023-06"), PLACES);
    expect(shape(f)).toEqual(shape(fresh()));
  });

  test("an unknown color mode is dropped", () => {
    expect(parseUrlState("?color=rainbow")).toEqual({});
    expect(parseUrlState("?color=")).toEqual({});
  });

  test("a malformed camera is dropped", () => {
    for (const bad of [
      "",
      "12",
      "12/46",
      "12/46/14/0",
      "a/b/c",
      "12/46/",
      "12//14",
      "Infinity/46/14",
      "1e3/46/14",
      "0x10/46/14",
    ]) {
      expect(parseUrlState(`?map=${bad}`), bad).toEqual({});
    }
  });

  test("a camera out of range is dropped", () => {
    for (const bad of ["23/46/14", "-1/46/14", "12/86/14", "12/-86/14", "12/46/181", "12/46/-181"]) {
      expect(parseUrlState(`?map=${bad}`), bad).toEqual({});
    }
  });

  test("a camera with fewer decimals or a negative position is fine", () => {
    expect(parseUrlState("?map=3/-33.9/-70.6").camera).toEqual({ center: [-70.6, -33.9], zoom: 3 });
  });

  test("unknown keys are ignored", () => {
    expect(parseUrlState("?utm_source=x&color=heat")).toEqual({ color: "heat" });
  });

  test("a format version this build doesn't know is ignored whole", () => {
    expect(parseUrlState("?v=2&color=heat&place=p1")).toEqual({});
    expect(parseUrlState("?v=1&color=heat")).toEqual({ color: "heat" });
  });

  test("a repeated key takes its first value", () => {
    expect(parseUrlState("?color=heat&color=grade").color).toBe("heat");
  });

  test("malformed percent-escapes don't throw", () => {
    expect(() => parseUrlState("?place=%E0%A4%A&color=heat")).not.toThrow();
    expect(parseUrlState("?place=%E0%A4%A&color=heat").color).toBe("heat");
  });
});

describe("sameCamera", () => {
  test("cameras that write the same are the same", () => {
    expect(sameCamera({ center: [14.500001, 46], zoom: 9.001 }, { center: [14.5, 46], zoom: 9 })).toBe(true);
  });

  test("a pan or a zoom is a different camera", () => {
    expect(sameCamera({ center: [14.5001, 46], zoom: 9 }, { center: [14.5, 46], zoom: 9 })).toBe(false);
    expect(sameCamera({ center: [14.5, 46], zoom: 9.1 }, { center: [14.5, 46], zoom: 9 })).toBe(false);
  });
});
