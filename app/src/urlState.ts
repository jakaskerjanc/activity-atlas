// Deep links: the state a URL carries, so a copied link or a reload shows what was on
// screen. Pure module (no React / DOM); ui/useUrlSync.ts writes it, App reads it once.
// Design: docs/superpowers/specs/2026-11-22-map-deep-links-design.md.
//
// The query string holds the state and the hash the page (ui/useView.ts), so old links
// (the bare map, #analytics, #activities) are links with every value at its default.
// Format v1, keys in this order, each written only when it isn't the default:
//
//   types   type names, sorted, comma-separated ("" = every type off)
//   from    first month of the date range, YYYY-MM
//   to      last month of the date range, YYYY-MM
//   place   place id
//   activity  selected activity id
//   group   "1": the selected activity's same-route group is open (highlighted)
//   color   color mode
//   map     camera: zoom/lat/lng (OSM order), 2 / 5 / 5 decimals
//
// No `v` means v1; another `v` is a format this build can't read, so the URL is read as
// the defaults. Unknown keys are ignored, so later versions can add keys. Parsing checks
// syntax only; filterFromUrl and selectionFromUrl check the values against the data.

import { defaultTypes, setFromMonth, setToMonth, type ActivityFilter } from "./activityFilter";
import { COLOR_MODES, type ColorMode } from "./colors";
import type { Camera } from "./homeCamera";

/** What a URL says. A missing key means the default. */
export interface UrlState {
  /** The type selection, sorted; [] = every type off. */
  readonly types?: readonly string[];
  /** Date range ends, month indices (format.ts: monthIndex). */
  readonly from?: number;
  readonly to?: number;
  readonly place?: string;
  readonly activity?: string;
  /** The selected activity's same-route group is open. */
  readonly group?: true;
  readonly color?: ColorMode;
  readonly camera?: Camera;
}

/** The app state a URL reproduces. */
export interface AppUrlState {
  readonly filter: ActivityFilter;
  readonly selectedId: string | null;
  /** The selected activity's same-route table is open (its routes highlighted). */
  readonly groupOpen: boolean;
  readonly colorMode: ColorMode;
  /** The map's camera, or null while it is still on the opening frame. */
  readonly camera: Camera | null;
}

const VERSION = "1";
const DEFAULT_COLOR: ColorMode = "uniform";
const ZOOM_DIGITS = 2;
/** About a metre. */
const POSITION_DIGITS = 5;
const MAX_ZOOM = 22;
/** Web Mercator's latitude limit. */
const MAX_LAT = 85.051129;

// --- Months ---------------------------------------------------------------

function formatMonthKey(index: number): string {
  const year = Math.floor(index / 12);
  return `${year}-${String(index - year * 12 + 1).padStart(2, "0")}`;
}

function parseMonthKey(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? Number(m[1]) * 12 + month - 1 : undefined;
}

// --- Camera ---------------------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;

function formatCamera(c: Camera): string {
  const [lng, lat] = c.center;
  return `${c.zoom.toFixed(ZOOM_DIGITS)}/${lat.toFixed(POSITION_DIGITS)}/${lng.toFixed(POSITION_DIGITS)}`;
}

function parseCamera(s: string): Camera | undefined {
  const parts = s.split("/");
  if (parts.length !== 3 || !parts.every((p) => DECIMAL.test(p))) return undefined;
  const [zoom, lat, lng] = parts.map(Number);
  if (zoom < 0 || zoom > MAX_ZOOM || Math.abs(lat) > MAX_LAT || Math.abs(lng) > 180) return undefined;
  return { center: [lng, lat], zoom };
}

/** Whether two cameras write the same `map` value: the URL can't tell them apart. */
export function sameCamera(a: Camera, b: Camera): boolean {
  return formatCamera(a) === formatCamera(b);
}

// --- The query string -----------------------------------------------------

const COLORS: readonly string[] = COLOR_MODES.map((m) => m.mode);

/** Parse a location.search ("?a=b", "a=b" or ""). Values that don't parse are left out. */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const v = params.get("v");
  if (v !== null && v !== VERSION) return {};
  const state: { -readonly [K in keyof UrlState]: UrlState[K] } = {};
  const types = params.get("types");
  if (types !== null) state.types = types === "" ? [] : types.split(",").filter(Boolean).sort();
  const from = parseMonthKey(params.get("from") ?? "");
  if (from !== undefined) state.from = from;
  const to = parseMonthKey(params.get("to") ?? "");
  if (to !== undefined) state.to = to;
  const place = params.get("place");
  if (place) state.place = place;
  const activity = params.get("activity");
  if (activity) state.activity = activity;
  if (params.get("group") === "1") state.group = true;
  const color = params.get("color");
  if (color !== null && COLORS.includes(color)) state.color = color as ColorMode;
  const camera = parseCamera(params.get("map") ?? "");
  if (camera) state.camera = camera;
  return state;
}

/** encodeURIComponent, with the separators that are safe in a query value put back. */
function encodeValue(s: string): string {
  return encodeURIComponent(s).replace(/%2C/gi, ",").replace(/%2F/gi, "/").replace(/%3A/gi, ":");
}

/** The search string for a state: "" when every value is the default, else "?…". */
export function formatUrlState(state: UrlState): string {
  const pairs: [string, string][] = [];
  if (state.types) pairs.push(["types", state.types.join(",")]);
  if (state.from !== undefined) pairs.push(["from", formatMonthKey(state.from)]);
  if (state.to !== undefined) pairs.push(["to", formatMonthKey(state.to)]);
  if (state.place !== undefined) pairs.push(["place", state.place]);
  if (state.activity !== undefined) pairs.push(["activity", state.activity]);
  if (state.group) pairs.push(["group", "1"]);
  if (state.color !== undefined) pairs.push(["color", state.color]);
  if (state.camera) pairs.push(["map", formatCamera(state.camera)]);
  if (pairs.length === 0) return "";
  return "?" + pairs.map(([k, v]) => `${k}=${encodeValue(v)}`).join("&");
}

// --- App state <-> URL state ----------------------------------------------

/** The URL state for the app's state: only what differs from the defaults. */
export function urlStateOf(app: AppUrlState): UrlState {
  const { filter } = app;
  const state: { -readonly [K in keyof UrlState]: UrlState[K] } = {};
  const types = [...filter.types].sort();
  const defaults = defaultTypes(filter.availableTypes);
  const isDefault = types.length === defaults.length && defaults.every((t) => filter.types.has(t));
  if (!isDefault) state.types = types;
  if (filter.fromMonth !== filter.minMonth) state.from = filter.fromMonth;
  if (filter.toMonth !== filter.maxMonth) state.to = filter.toMonth;
  if (filter.place !== null) state.place = filter.place;
  if (app.selectedId !== null) {
    state.activity = app.selectedId;
    if (app.groupOpen) state.group = true;
  }
  if (app.colorMode !== DEFAULT_COLOR) state.color = app.colorMode;
  if (app.camera) state.camera = app.camera;
  return state;
}

/**
 * A new filter (createActivityFilter) with the URL's filter values, checked against its
 * data: types it doesn't have are dropped (none left: the default types), months are
 * pulled into its span (a start after the end: the full span), and a place not in
 * `places` is no place.
 */
export function filterFromUrl(
  filter: ActivityFilter,
  state: UrlState,
  places: { has(id: string): boolean },
): ActivityFilter {
  let next = filter;
  if (state.types) {
    const known = state.types.filter((t) => filter.availableTypes.includes(t));
    if (state.types.length === 0 || known.length > 0) next = { ...next, types: new Set(known) };
  }
  const from = state.from ?? filter.minMonth;
  const to = state.to ?? filter.maxMonth;
  if (from <= to) next = setFromMonth(setToMonth(next, to), from);
  if (state.place !== undefined && places.has(state.place)) next = { ...next, place: state.place };
  return next;
}

/**
 * The URL's selected activity, if `filter` has it, and the same-route group to open: the
 * activity's own, when the URL asks for it and the activity is on one.
 */
export function selectionFromUrl(
  state: UrlState,
  filter: ActivityFilter,
): { selectedId: string | null; groupRoute: string | null } {
  const a = state.activity === undefined ? undefined : filter.activities.find((x) => x.id === state.activity);
  if (!a) return { selectedId: null, groupRoute: null };
  return { selectedId: a.id, groupRoute: state.group && a.route !== undefined ? a.route : null };
}
