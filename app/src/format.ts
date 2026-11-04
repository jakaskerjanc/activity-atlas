// Pure display formatters for activity stats. No React / Mapbox deps.

import type { ActivitySource } from "./types";

const DASH = "—";

/** meters -> km string, `digits` decimals (default 1). Dash when unknown. */
export function formatKm(meters: number | undefined, digits = 1): string {
  if (meters == null) return DASH;
  return (meters / 1000).toFixed(digits);
}

/** meters -> rounded whole meters with thousands separators, e.g. "1,204". */
export function formatMeters(meters: number | undefined): string {
  if (meters == null) return DASH;
  return Math.round(meters).toLocaleString("en-US");
}

/** seconds -> "1h 39m" or "47m". Dash when unknown. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return DASH;
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** min:sec per km, e.g. "5:06". Dash when either input is unknown or distance is zero. */
export function pacePerKm(meters: number | undefined, seconds: number | undefined): string {
  if (meters == null || seconds == null || meters <= 0) return DASH;
  const secPerKm = seconds / (meters / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** km/h with one decimal. Dash when either input is unknown or time is zero. */
export function speedKmh(meters: number | undefined, seconds: number | undefined): string {
  if (meters == null || seconds == null || seconds <= 0) return DASH;
  return (meters / 1000 / (seconds / 3600)).toFixed(1);
}

/** epoch seconds -> "Aug 18, 2024" (UTC, deterministic). */
export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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

/** month index -> "August 2024" (UTC, deterministic). */
export function formatMonth(index: number): string {
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** Whether a Strava sport_type is measured by pace (foot) vs speed (wheel/water). */
export function isFootBased(type: string): boolean {
  return /run|walk|hike/i.test(type);
}

/**
 * Resolve an activity's live sources to their provider pages, in source order.
 * A provider this build doesn't know is skipped, so the UI just shows fewer links.
 */
export function activityLinks(sources: ActivitySource[]): { url: string; label: string }[] {
  const links: { url: string; label: string }[] = [];
  for (const { provider, id } of sources) {
    if (provider === "strava") {
      links.push({ url: `https://www.strava.com/activities/${id}`, label: "View on Strava" });
    } else if (provider === "garmin") {
      links.push({
        url: `https://connect.garmin.com/modern/activity/${id}`,
        label: "View on Garmin Connect",
      });
    }
  }
  return links;
}
