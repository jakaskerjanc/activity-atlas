// Year against year on the Analytics page: the visible activities' running total through
// the calendar year, one line per year, so this year reads against the earlier ones on
// the same date. Days are UTC, like the date range and the calendar. Every year is laid
// on one leap reference year, so 1 March lines up whether or not the year had a 29 Feb.
// An activity without the measure is left out, never treated as 0. Pure module, no React.

import type { ActivityRecord } from "./types";

export type YearMeasure = "distance" | "climbing" | "time";

/** Days in the reference year: day 0 is 1 Jan, day 365 is 31 Dec. */
export const REF_DAYS = 366;
const REF_YEAR = 2024;
const DAY_MS = 86400000;

/** The day of the reference year a UTC month (0-based) and date fall on. */
export function refDayOf(month: number, date: number): number {
  return (Date.UTC(REF_YEAR, month, date) - Date.UTC(REF_YEAR, 0, 1)) / DAY_MS;
}

function refDay(ts: number): number {
  const d = new Date(ts * 1000);
  return refDayOf(d.getUTCMonth(), d.getUTCDate());
}

const yearOf = (ts: number) => new Date(ts * 1000).getUTCFullYear();

// Built once, as the chart's tooltip formats a day on every pointer move (a
// toLocaleDateString with options builds a new formatter per call).
const REF_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A day of the reference year as "Nov 15". */
export function formatRefDay(day: number): string {
  return REF_DAY.format(Date.UTC(REF_YEAR, 0, 1 + day));
}

export interface YearLine {
  year: number;
  /**
   * The first and last day the line covers: 1 Jan to 31 Dec, cut to the date range in
   * its first and last year (and to today in the current one).
   */
  fromDay: number;
  toDay: number;
  /** The running total at the end of each day, index 0 being fromDay. Base units (m or s). */
  cumulative: number[];
  /** The total at toDay. */
  total: number;
}

function measureOf(a: ActivityRecord, measure: YearMeasure): number | undefined {
  const v = measure === "distance" ? a.distance : measure === "climbing" ? a.elevation_gain : a.moving_time;
  return v != null && Number.isFinite(v) ? v : undefined;
}

/**
 * One line per year, oldest first, from the first year with a counted activity to the
 * year `end` falls in; a year in between without any is a flat line, since a gap is a
 * real gap. `from` and `end` are the date range in epoch seconds, `end` no later than now.
 */
export function yearLines(
  activities: readonly ActivityRecord[],
  from: number,
  end: number,
  measure: YearMeasure,
): YearLine[] {
  const counted = activities.flatMap((a) => {
    const value = measureOf(a, measure);
    return value == null || a.ts < from || a.ts > end ? [] : [{ ts: a.ts, value }];
  });
  if (counted.length === 0) return [];
  const firstYear = Math.min(...counted.map((c) => yearOf(c.ts)));
  const lastYear = yearOf(end);
  const fromYear = yearOf(from);
  const lines: YearLine[] = [];
  for (let year = firstYear; year <= lastYear; year++) {
    const fromDay = year === fromYear ? refDay(from) : 0;
    const toDay = year === lastYear ? refDay(end) : REF_DAYS - 1;
    lines.push({ year, fromDay, toDay, cumulative: new Array<number>(toDay - fromDay + 1).fill(0), total: 0 });
  }
  for (const c of counted) {
    const line = lines[yearOf(c.ts) - firstYear];
    line.cumulative[refDay(c.ts) - line.fromDay] += c.value;
  }
  for (const line of lines) {
    let sum = 0;
    line.cumulative = line.cumulative.map((v) => (sum += v));
    line.total = sum;
  }
  return lines;
}

/** A line's running total at the end of a day; undefined outside the days it covers. */
export function valueOn(line: YearLine, day: number): number | undefined {
  return day < line.fromDay || day > line.toDay ? undefined : line.cumulative[day - line.fromDay];
}

export interface YearComparison {
  year: number;
  /** The newest year's last day, which both totals are read on. */
  day: number;
  value: number;
  /** The year before, and its total on the same day. */
  against: number;
  againstValue: number;
}

/**
 * The newest year against the one before it, on the newest year's last day. Null when
 * there is no year before, or when the two lines don't start on the same day (a date
 * range that begins mid-year would compare a part year with a whole one).
 */
export function yearComparison(lines: readonly YearLine[]): YearComparison | null {
  if (lines.length < 2) return null;
  const latest = lines[lines.length - 1];
  const before = lines[lines.length - 2];
  if (latest.fromDay !== before.fromDay) return null;
  const againstValue = valueOn(before, latest.toDay);
  if (againstValue == null) return null;
  return { year: latest.year, day: latest.toDay, value: latest.total, against: before.year, againstValue };
}

/** A measure's value for a label: "1,812 km", "24,310 m", "182 h". */
export function formatMeasure(value: number, measure: YearMeasure): string {
  if (measure === "distance") return `${Math.round(value / 1000).toLocaleString("en-US")} km`;
  if (measure === "climbing") return `${Math.round(value).toLocaleString("en-US")} m`;
  const h = value / 3600;
  return `${(h < 10 ? Math.round(h * 10) / 10 : Math.round(h)).toLocaleString("en-US")} h`;
}

/** Base units per axis unit (km, m, h), and the unit's suffix. */
export const MEASURE_AXIS: Record<YearMeasure, { per: number; unit: string }> = {
  distance: { per: 1000, unit: " km" },
  climbing: { per: 1, unit: " m" },
  time: { per: 3600, unit: " h" },
};
