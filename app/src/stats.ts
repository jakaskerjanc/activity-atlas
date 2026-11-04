// Pure stat view-models for the right panel. No React / Mapbox deps.

import type { ActivityFeature, ActivityRecord } from "./types";
import {
  formatKm,
  formatDuration,
  formatMeters,
  pacePerKm,
  speedKmh,
  isFootBased,
} from "./format";

export interface StatCard {
  value: string;
  label: string;
  /** true = render in accent color */
  accent?: boolean;
}

/** A sum over the activities that have a value, and how many those are. */
export interface Coverage {
  sum: number;
  n: number;
}

export interface Totals {
  count: number;
  distance: Coverage;
  elevation: Coverage;
  moving: Coverage;
}

function add(c: Coverage, v: number | undefined) {
  if (v == null) return;
  c.sum += v;
  c.n += 1;
}

/**
 * Sum distance / elevation / moving time over a set of activities, skipping unknowns.
 * The map's totals and the analytics page's totals both come from here.
 */
export function aggregate(activities: readonly ActivityRecord[]): Totals {
  const t: Totals = {
    count: 0,
    distance: { sum: 0, n: 0 },
    elevation: { sum: 0, n: 0 },
    moving: { sum: 0, n: 0 },
  };
  for (const p of activities) {
    t.count += 1;
    add(t.distance, p.distance);
    add(t.elevation, p.elevation_gain);
    add(t.moving, p.moving_time);
  }
  return t;
}

/** A total card: the sum over activities that have the value, or a dash when none do. */
function totalCard(c: Coverage, format: (v: number) => string, card: Omit<StatCard, "value">): StatCard {
  return { value: c.n === 0 ? "—" : format(c.sum), ...card };
}

/** Four aggregate cards for the visible activities. */
export function totalCards(activities: readonly ActivityRecord[]): StatCard[] {
  const t = aggregate(activities);
  return [
    { value: String(t.count), label: "Activities" },
    totalCard(t.distance, (m) => formatKm(m, 0), { label: "Total km", accent: true }),
    totalCard(t.elevation, formatMeters, { label: "Elevation m" }),
    totalCard(t.moving, formatDuration, { label: "Moving" }),
  ];
}

/** Four cards for a single selected activity. Unknown values read "—". */
export function activityCards(feature: ActivityFeature): StatCard[] {
  const p = feature.properties;
  const foot = isFootBased(p.type);
  return [
    { value: formatKm(p.distance), label: "Distance km", accent: true },
    { value: formatDuration(p.moving_time), label: "Moving" },
    { value: formatMeters(p.elevation_gain), label: "Elevation m" },
    foot
      ? { value: pacePerKm(p.distance, p.moving_time), label: "Pace /km" }
      : { value: speedKmh(p.distance, p.moving_time), label: "Speed km/h" },
  ];
}
