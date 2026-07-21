// Pure stat view-models for the right panel. No React / Mapbox deps.

import type { ActivityFeature } from "./types";
import {
  formatKm,
  formatDuration,
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

export interface Totals {
  count: number;
  totalDistanceM: number;
  totalElevationM: number;
  totalMovingSec: number;
}

/** Sum distance / elevation / moving time over a set of activities. */
export function aggregate(features: ActivityFeature[]): Totals {
  return features.reduce<Totals>(
    (acc, f) => {
      acc.count += 1;
      acc.totalDistanceM += f.properties.distance;
      acc.totalElevationM += f.properties.elevation_gain;
      acc.totalMovingSec += f.properties.moving_time;
      return acc;
    },
    { count: 0, totalDistanceM: 0, totalElevationM: 0, totalMovingSec: 0 },
  );
}

/** Four aggregate cards for the current filter. */
export function totalCards(features: ActivityFeature[]): StatCard[] {
  const t = aggregate(features);
  return [
    { value: String(t.count), label: "Activities" },
    { value: formatKm(t.totalDistanceM, 0), label: "Total km", accent: true },
    { value: Math.round(t.totalElevationM).toLocaleString(), label: "Elevation m" },
    { value: formatDuration(t.totalMovingSec), label: "Moving" },
  ];
}

/** Four cards for a single selected activity. */
export function activityCards(feature: ActivityFeature): StatCard[] {
  const p = feature.properties;
  const foot = isFootBased(p.type);
  return [
    { value: formatKm(p.distance), label: "Distance km", accent: true },
    { value: formatDuration(p.moving_time), label: "Moving" },
    { value: Math.round(p.elevation_gain).toLocaleString(), label: "Elevation m" },
    foot
      ? { value: pacePerKm(p.distance, p.moving_time), label: "Pace /km" }
      : { value: speedKmh(p.distance, p.moving_time), label: "Speed km/h" },
  ];
}
