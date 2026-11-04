// activities table row -> activities.json record. The database keeps what each
// provider reported, including 0 written for "not measured"; this is where those
// zeros become absent, so the site never shows or sums them as real values.

import type { ActivityRecord, ActivitySource, Channel } from "./types.ts";

/** The activities columns the display build reads. Numbers may be NULL. */
export interface ActivityRow {
  id: string;
  name: string;
  type: string;
  start_time: string;
  start_local: string | null;
  distance: number | null;
  moving_time: number | null;
  elapsed_time: number | null;
  elevation_gain: number | null;
  elevation_loss: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  /** JSON array text */
  hr_zone_seconds: string | null;
  has_gps: number;
  has_hr: number;
  has_altitude: number;
  has_cadence: number;
  has_power: number;
  polyline: string;
  streams_sha256: string | null;
}

const CHANNEL_FLAGS: [Channel, keyof ActivityRow][] = [
  ["gps", "has_gps"],
  ["hr", "has_hr"],
  ["altitude", "has_altitude"],
  ["cadence", "has_cadence"],
  ["power", "has_power"],
];

/** A positive number, else undefined (NULL or a provider's 0 = not measured). */
function positive(v: number | null): number | undefined {
  return v != null && v > 0 ? v : undefined;
}

/** Elevation: 0 is a real value only when an altimeter/DEM channel exists. */
function elevation(v: number | null, hasAltitude: boolean): number | undefined {
  if (v == null) return undefined;
  if (v === 0 && !hasAltitude) return undefined;
  return v;
}

function hrZones(text: string | null, hasHr: boolean): number[] | undefined {
  if (!hasHr || text == null) return undefined;
  const zones = JSON.parse(text) as number[];
  return Array.isArray(zones) && zones.some((s) => s > 0) ? zones : undefined;
}

export function toRecord(row: ActivityRow, sources: ActivitySource[], hasDetail: boolean): ActivityRecord {
  const hasAlt = row.has_altitude === 1;
  const optional: Partial<ActivityRecord> = {
    start_local: row.start_local ?? undefined,
    distance: positive(row.distance),
    moving_time: positive(row.moving_time),
    elapsed_time: positive(row.elapsed_time),
    elevation_gain: elevation(row.elevation_gain, hasAlt),
    elevation_loss: elevation(row.elevation_loss, hasAlt),
    avg_hr: positive(row.avg_hr),
    max_hr: positive(row.max_hr),
    hr_zones: hrZones(row.hr_zone_seconds, row.has_hr === 1),
  };
  const rec: ActivityRecord = {
    id: row.id,
    name: row.name,
    type: row.type,
    ts: Math.floor(Date.parse(row.start_time) / 1000),
    start_date: row.start_time,
    channels: [],
    sources,
  };
  // Present values only: an absent key is how the wire says "unknown".
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (rec as unknown as Record<string, unknown>)[k] = v;
  // channels and sources after the numbers, for readable JSON.
  delete (rec as Partial<ActivityRecord>).channels;
  delete (rec as Partial<ActivityRecord>).sources;
  rec.channels = CHANNEL_FLAGS.filter(([, flag]) => row[flag] === 1).map(([c]) => c);
  rec.sources = sources;
  if (hasDetail) rec.detail = true;
  return rec;
}
