// Pure stat view-models for the right panel. No React / Mapbox deps.

import type { ActivityFeature } from "./types";
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
  /** Coverage caveat, e.g. "437 of 447" when some activities lack the value. */
  note?: string;
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

/** Sum distance / elevation / moving time over a set of activities, skipping unknowns. */
export function aggregate(features: ActivityFeature[]): Totals {
  const t: Totals = {
    count: 0,
    distance: { sum: 0, n: 0 },
    elevation: { sum: 0, n: 0 },
    moving: { sum: 0, n: 0 },
  };
  for (const f of features) {
    const p = f.properties;
    t.count += 1;
    add(t.distance, p.distance);
    add(t.elevation, p.elevation_gain);
    add(t.moving, p.moving_time);
  }
  return t;
}

/** A total card: dash when nobody has the value, a coverage note when only some do. */
function totalCard(c: Coverage, count: number, format: (v: number) => string, card: Omit<StatCard, "value">): StatCard {
  const out: StatCard = { value: c.n === 0 ? "—" : format(c.sum), ...card };
  if (c.n > 0 && c.n < count) out.note = `${c.n} of ${count}`;
  return out;
}

/** Four aggregate cards for the current filter. */
export function totalCards(features: ActivityFeature[]): StatCard[] {
  const t = aggregate(features);
  return [
    { value: String(t.count), label: "Activities" },
    totalCard(t.distance, t.count, (m) => formatKm(m, 0), { label: "Total km", accent: true }),
    totalCard(t.elevation, t.count, formatMeters, { label: "Elevation m" }),
    totalCard(t.moving, t.count, formatDuration, { label: "Moving" }),
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
