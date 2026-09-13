// Pure display formatters for activity stats. No React / Mapbox deps.

const DASH = "—";

/** meters -> km string, `digits` decimals (default 1). */
export function formatKm(meters: number, digits = 1): string {
  return (meters / 1000).toFixed(digits);
}

/** seconds -> "1h 39m" or "47m". */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** min:sec per km, e.g. "5:06". Dash when distance is zero. */
export function pacePerKm(meters: number, seconds: number): string {
  if (meters <= 0) return DASH;
  const secPerKm = seconds / (meters / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** km/h with one decimal. Dash when time is zero. */
export function speedKmh(meters: number, seconds: number): string {
  if (seconds <= 0) return DASH;
  return (meters / 1000 / (seconds / 3600)).toFixed(1);
}

/** epoch seconds -> "Aug 18" (UTC, deterministic). */
export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** epoch seconds -> "Aug 18, 2024" (UTC, deterministic). */
export function formatDateYear(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Whether a Strava sport_type is measured by pace (foot) vs speed (wheel/water). */
export function isFootBased(type: string): boolean {
  return /run|walk|hike/i.test(type);
}

/**
 * Resolve a namespaced wire id ("s:123" / "g:456") to its source's activity page.
 * Returns null for anything unrecognized so the UI just renders plain text.
 */
export function activityLink(id: string): { url: string; label: string } | null {
  const sep = id.indexOf(":");
  if (sep < 1) return null;
  const raw = id.slice(sep + 1);
  if (!raw) return null;
  if (id[0] === "s") return { url: `https://www.strava.com/activities/${raw}`, label: "View on Strava" };
  if (id[0] === "g") return { url: `https://connect.garmin.com/modern/activity/${raw}`, label: "View on Garmin Connect" };
  return null;
}
