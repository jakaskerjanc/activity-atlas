// Heart-rate zones on the Analytics page: how the visible activities' time with heart
// rate splits across the bands (below zone 1, then zones 1 to 5), over the whole set
// and per month of the date range (UTC months, like the date range). Every record's
// hr_zones is measured against the same reference limits (activities.json's
// hr_zone_limits), so the seconds add up across time. Records without zones are left
// out and counted, never treated as 0. Pure module, no React.

import { monthIndex } from "./format";
import type { ActivityRecord } from "./types";

/** Bands: below zone 1, then zones 1 to 5. */
export const ZONE_BANDS = 6;

export interface ZoneBand {
  /** "Below zone 1", "Zone 1" … "Zone 5" */
  label: string;
  /** "under 100 bpm", "100–119 bpm" … "179+ bpm" */
  range: string;
}

/** The six bands' names and bpm ranges, from the reference limits (lower bounds of zones 1–5). */
export function zoneBands(limits: readonly number[]): ZoneBand[] {
  return Array.from({ length: ZONE_BANDS }, (_, i) => {
    if (i === 0) return { label: "Below zone 1", range: `under ${limits[0]} bpm` };
    const range = i < ZONE_BANDS - 1 ? `${limits[i - 1]}–${limits[i]} bpm` : `${limits[i - 1]}+ bpm`;
    return { label: `Zone ${i}`, range };
  });
}

export interface ZoneMonth {
  /** Month index (format.ts: monthIndex). */
  month: number;
  /** Seconds in each band. */
  seconds: number[];
  /** Seconds over all bands. */
  total: number;
  /** Activities with zones that started this month. */
  activities: number;
}

export interface ZoneSummary {
  /** Seconds in each band over every counted activity. */
  seconds: number[];
  total: number;
  /**
   * One entry per month from the first month with zone time to toMonth: months before
   * that are left off, empty months after it are kept (a gap is a real gap).
   */
  months: ZoneMonth[];
  /** Activities with zones. */
  counted: number;
  /** Activities without zones (no heart rate, or no limits to measure against). */
  missing: number;
}

function validZones(z: number[] | undefined): z is number[] {
  return (
    Array.isArray(z) && z.length === ZONE_BANDS && z.every((s) => Number.isFinite(s) && s >= 0) && z.some((s) => s > 0)
  );
}

export function zoneSummary(
  activities: readonly ActivityRecord[],
  fromMonth: number,
  toMonth: number,
): ZoneSummary {
  const blank = () => new Array<number>(ZONE_BANDS).fill(0);
  const months: ZoneMonth[] = [];
  for (let m = fromMonth; m <= toMonth; m++) months.push({ month: m, seconds: blank(), total: 0, activities: 0 });
  const out: ZoneSummary = { seconds: blank(), total: 0, months, counted: 0, missing: 0 };
  for (const a of activities) {
    if (!validZones(a.hr_zones)) {
      out.missing += 1;
      continue;
    }
    out.counted += 1;
    const month = months[monthIndex(a.ts) - fromMonth];
    a.hr_zones.forEach((s, i) => {
      out.seconds[i] += s;
      out.total += s;
      if (month) {
        month.seconds[i] += s;
        month.total += s;
      }
    });
    if (month) month.activities += 1;
  }
  const first = months.findIndex((m) => m.total > 0);
  out.months = first < 0 ? [] : months.slice(first);
  return out;
}

/** A share as a whole percentage; a share above 0 that rounds to 0 reads "<1%". */
export function formatShare(part: number, total: number): string {
  if (!(total > 0) || part <= 0) return "0%";
  const pct = (100 * part) / total;
  return pct < 0.5 ? "<1%" : `${Math.round(pct)}%`;
}

/** Time for a label: minutes under an hour, one decimal under 10 h, whole hours above. */
export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  if (h === 0) return "0 h";
  if (seconds < 59.5) return "<1 min";
  if (seconds < 3570) return `${Math.round(seconds / 60)} min`;
  if (h < 10) return `${h.toFixed(1)} h`;
  return `${Math.round(h).toLocaleString("en-US")} h`;
}
