// Pure display formatters for activity stats. No React / Mapbox deps.

import type { ActivitySource } from "./types";

const DASH = "—";

// The formatters are built once and reused. toLocaleString / toLocaleDateString with
// options build a new Intl formatter on every call (tens of µs each, against about 1 µs
// for a kept one), and these run per row of the Activities page, per search-index entry
// and per tooltip move. Same locale and options, so the strings are the same.

/** One km formatter per decimal count, made on first use. */
const kmFormats = new Map<number, Intl.NumberFormat>();

/** meters -> km string, `digits` decimals (default 1), thousands separated: "2,540". Dash when unknown. */
export function formatKm(meters: number | undefined, digits = 1): string {
  if (meters == null) return DASH;
  let f = kmFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    kmFormats.set(digits, f);
  }
  return f.format(meters / 1000);
}

const WHOLE = new Intl.NumberFormat("en-US");

/** meters -> rounded whole meters with thousands separators, e.g. "1,204". */
export function formatMeters(meters: number | undefined): string {
  if (meters == null) return DASH;
  return WHOLE.format(Math.round(meters));
}

/** seconds -> "1h 39m" or "47m". Dash when unknown. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return DASH;
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A duration as number/unit pairs, so the letters can be set like any other unit:
 * 5933 s -> [{ "1", "h" }, { "39", "m" }]. Same rounding as formatDuration; undefined
 * when unknown.
 */
export function durationParts(seconds: number | undefined): { value: string; unit: string }[] | undefined {
  if (seconds == null) return undefined;
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = { value: String(total % 60), unit: "m" };
  return h ? [{ value: String(h), unit: "h" }, m] : [m];
}

/** min:sec per km, e.g. "5:06". Dash when either input is unknown or distance is zero. */
export function pacePerKm(meters: number | undefined, seconds: number | undefined): string {
  if (meters == null || seconds == null || meters <= 0) return DASH;
  const secPerKm = seconds / (meters / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** seconds per km -> "5:06". */
export function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** seconds -> "2:14:05", or "14:05" under an hour. */
export function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The local wall-clock span of an activity: "07:42–08:44" from its local start and
 * elapsed time, or just "07:42" without the elapsed time. Undefined without a local
 * start. A span past midnight wraps ("23:30–00:21").
 */
export function timeSpan(startLocal: string | undefined, elapsed: number | undefined): string | undefined {
  const start = startLocal?.slice(11, 16);
  if (!start || !/^\d\d:\d\d$/.test(start)) return undefined;
  if (elapsed === undefined) return start;
  const [h, m] = start.split(":").map(Number);
  const end = (h * 60 + m + Math.round(elapsed / 60)) % (24 * 60);
  return `${start}–${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

/** km/h with one decimal. Dash when either input is unknown or time is zero. */
export function speedKmh(meters: number | undefined, seconds: number | undefined): string {
  if (meters == null || seconds == null || seconds <= 0) return DASH;
  return (meters / 1000 / (seconds / 3600)).toFixed(1);
}

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** epoch seconds -> "Aug 18, 2024" (UTC, deterministic). */
export function formatDate(ts: number): string {
  return DATE.format(new Date(ts * 1000));
}

// --- Months ---------------------------------------------------------------
// The date-range slider steps by whole months, so its bounds live in month-index
// space (an integer that increments by one per calendar month) rather than epoch
// seconds, which have no constant month-sized step.

/** epoch seconds -> UTC month index (year * 12 + zero-based month). */
export function monthIndex(ts: number): number {
  const d = new Date(ts * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** First instant of a month index: 00:00:00 UTC on the 1st. */
export function monthStart(index: number): number {
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  return Date.UTC(year, month, 1) / 1000;
}

/** Last instant of a month index: 23:59:59 UTC on the final day. */
export function monthEnd(index: number): number {
  return monthStart(index + 1) - 1;
}

const MONTH = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", timeZone: "UTC" });

/** month index -> "August 2024" (UTC, deterministic). */
export function formatMonth(index: number): string {
  return MONTH.format(monthStart(index) * 1000);
}

/** month index -> "Aug 2024" (UTC, deterministic). */
export function formatMonthShort(index: number): string {
  return MONTH_SHORT.format(monthStart(index) * 1000);
}

/** Whether a Strava sport_type is measured by pace (foot) vs speed (wheel/water). */
export function isFootBased(type: string): boolean {
  return /run|walk|hike/i.test(type);
}

// Types whose words don't split cleanly on case.
const TYPE_LABELS: Record<string, string> = {
  EBikeRide: "E-bike ride",
  EMountainBikeRide: "E-mountain bike ride",
};

/**
 * A Strava sport_type as words, in sentence case: "WeightTraining" -> "Weight training".
 * Display only: filters, colors and keys keep the raw type.
 */
export function typeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known) return known;
  const words = type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(" ");
}

/** An activity's page on a provider: `short` is the letter its badge shows. */
export interface ActivityLink {
  url: string;
  label: string;
  short: string;
}

/**
 * Resolve an activity's live sources to their provider pages, Garmin before Strava so the
 * badges always read "G S". A provider this build doesn't know is skipped, so the UI just
 * shows fewer links.
 */
export function activityLinks(sources: ActivitySource[]): ActivityLink[] {
  const links: ActivityLink[] = [];
  for (const provider of ["garmin", "strava"] as const) {
    for (const s of sources) {
      if (s.provider !== provider) continue;
      links.push(
        provider === "garmin"
          ? { url: `https://connect.garmin.com/modern/activity/${s.id}`, label: "View on Garmin Connect", short: "G" }
          : { url: `https://www.strava.com/activities/${s.id}`, label: "View on Strava", short: "S" },
      );
    }
  }
  return links;
}
