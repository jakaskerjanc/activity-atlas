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
  /** Shown small after the value ("km"); omitted for counts and durations. */
  unit?: string;
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
    { value: t.count.toLocaleString("en-US"), label: "Activities" },
    totalCard(t.distance, (m) => formatKm(m, 0), { unit: "km", label: "Distance", accent: true }),
    totalCard(t.elevation, formatMeters, { unit: "m", label: "Elevation gain" }),
    totalCard(t.moving, formatDuration, { label: "Moving time" }),
  ];
}

/** Four cards for a single selected activity. Unknown values read "—". */
export function activityCards(feature: ActivityFeature): StatCard[] {
  const p = feature.properties;
  const foot = isFootBased(p.type);
  return [
    { value: formatKm(p.distance), unit: "km", label: "Distance", accent: true },
    { value: formatDuration(p.moving_time), label: "Moving time" },
    { value: formatMeters(p.elevation_gain), unit: "m", label: "Elevation gain" },
    foot
      ? { value: pacePerKm(p.distance, p.moving_time), unit: "/km", label: "Pace" }
      : { value: speedKmh(p.distance, p.moving_time), unit: "km/h", label: "Speed" },
  ];
}

/** The middle value of a non-empty list (the mean of the two middle values when even). */
export function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** The value at quantile q (0..1) of a non-empty list, nearest rank. */
export function quantile(values: readonly number[], q: number): number {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.round(q * (v.length - 1))];
}
