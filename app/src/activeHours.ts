// Active hours: how much time the visible activities spent out in each hour of the day,
// by the local wall clock at the start. An activity counts in every hour it covers (a
// three-hour hike fills three hours), wrapping past midnight; a shift to or from
// daylight saving inside an activity is ignored.

import type { ActivityRecord } from "./types";

const HOUR_SEC = 3600;
const DAY_SEC = 24 * HOUR_SEC;

export interface ActiveHours {
  /** Seconds out in each local hour, 0 = 00:00–01:00. */
  seconds: number[];
  /** How many activities were out during each hour. */
  activities: number[];
  /** Seconds over all hours. */
  total: number;
  /** Activities left out: no local start time or no duration. */
  skipped: number;
}

/** Seconds after local midnight of a start_local ("2026-11-06T17:26:00"), or null. */
export function localSecondOfDay(startLocal: string | undefined): number | null {
  const m = startLocal?.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return null;
  return h * HOUR_SEC + min * 60 + s;
}

/** 0 = Monday ... 6 = Sunday of a start_local's own date, or null. */
export function localWeekday(startLocal: string | undefined): number | null {
  const m = startLocal?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return Number.isNaN(day) ? null : (day + 6) % 7;
}

/** Weekdays (Monday–Friday) and weekends, by the local date each activity started on. */
export interface WeekSplit {
  weekdays: ActiveHours;
  weekends: ActiveHours;
  /** Activities in neither clock: no local start, or no duration. */
  skipped: number;
}

export function activeHoursByWeekPart(activities: readonly ActivityRecord[]): WeekSplit {
  const weekdays: ActivityRecord[] = [];
  const weekends: ActivityRecord[] = [];
  let undated = 0;
  for (const a of activities) {
    const wd = localWeekday(a.start_local);
    if (wd == null) undated += 1;
    else (wd >= 5 ? weekends : weekdays).push(a);
  }
  const split = { weekdays: activeHours(weekdays), weekends: activeHours(weekends) };
  return { ...split, skipped: undated + split.weekdays.skipped + split.weekends.skipped };
}

export function activeHours(activities: readonly ActivityRecord[]): ActiveHours {
  const out: ActiveHours = {
    seconds: new Array(24).fill(0),
    activities: new Array(24).fill(0),
    total: 0,
    skipped: 0,
  };
  for (const a of activities) {
    const start = localSecondOfDay(a.start_local);
    // Time out, door to door: elapsed time, else moving time when that is all there is.
    const duration = a.elapsed_time ?? a.moving_time;
    if (start == null || duration == null || !(duration > 0)) {
      out.skipped += 1;
      continue;
    }
    const touched = new Set<number>();
    let t = start;
    let left = duration;
    while (left > 0) {
      const hour = Math.floor(t / HOUR_SEC) % 24;
      const chunk = Math.min(left, HOUR_SEC - (t % HOUR_SEC));
      out.seconds[hour] += chunk;
      touched.add(hour);
      t = (t + chunk) % DAY_SEC;
      left -= chunk;
    }
    for (const h of touched) out.activities[h] += 1;
    out.total += duration;
  }
  return out;
}

/** The hour with the most time out (the earliest on a tie), or null with none. */
export function busiestHour(h: ActiveHours): number | null {
  if (h.total === 0) return null;
  return h.seconds.indexOf(Math.max(...h.seconds));
}
