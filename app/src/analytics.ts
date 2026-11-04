// Pure stat view-models for the Analytics page. No React / Mapbox deps. Everything is
// derived in the browser from the visible activities, so it follows the Activity filter
// and reconciles with the map's totals.

import type { ActivityFeature } from "./types";
import type { StatCard } from "./stats";
import { formatKm } from "./format";

const DAY_SEC = 86400;
const WEEK_SEC = 7 * DAY_SEC;

export interface Consistency {
  /** Active days: distinct UTC calendar days with at least one activity. */
  activeDays: number;
  /** Most consecutive active days. */
  longestStreak: number;
  activitiesPerWeek: number;
  distancePerWeekM: number;
}

/**
 * How regularly the activities happened. Weekly averages are over the inclusive span
 * [fromTs, toTs] in epoch seconds, counted as at least one week so a short span doesn't
 * inflate them.
 */
export function consistency(
  features: readonly ActivityFeature[],
  fromTs: number,
  toTs: number,
): Consistency {
  const days = [...new Set(features.map((f) => Math.floor(f.properties.ts / DAY_SEC)))].sort(
    (a, b) => a - b,
  );
  let longestStreak = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }

  const weeks = Math.max(1, (toTs - fromTs + 1) / WEEK_SEC);
  const distance = features.reduce((sum, f) => sum + f.properties.distance, 0);
  return {
    activeDays: days.length,
    longestStreak,
    activitiesPerWeek: features.length / weeks,
    distancePerWeekM: distance / weeks,
  };
}

/** Four cards in the same 2x2 layout as the map's totals. */
export function consistencyCards(c: Consistency): StatCard[] {
  return [
    { value: c.activitiesPerWeek.toFixed(1), label: "Activities / week" },
    { value: formatKm(c.distancePerWeekM), label: "Km / week", accent: true },
    { value: String(c.activeDays), label: "Active days" },
    {
      value: `${c.longestStreak} ${c.longestStreak === 1 ? "day" : "days"}`,
      label: "Longest streak",
    },
  ];
}

// --- Activity calendar -----------------------------------------------------
// A GitHub-style grid per calendar year: one cell per UTC day, weeks as columns
// (Monday first), shaded by that day's moving time.

const HOUR_SEC = 3600;

/** Shade step of a calendar day: 0 = no activity, then <1h, 1-2h, 2-4h, 4h+. */
export type CalendarLevel = 0 | 1 | 2 | 3 | 4;

export function calendarLevel(movingSec: number, count: number): CalendarLevel {
  if (count === 0) return 0;
  if (movingSec < HOUR_SEC) return 1;
  if (movingSec < 2 * HOUR_SEC) return 2;
  if (movingSec < 4 * HOUR_SEC) return 3;
  return 4;
}

export interface CalendarDay {
  /** 00:00 UTC of the day, epoch seconds. */
  ts: number;
  /** Column: week of the year, weeks starting Monday. */
  week: number;
  /** Row: 0 = Monday ... 6 = Sunday. */
  weekday: number;
  /** Moving time of the activities that started this day. */
  movingSec: number;
  count: number;
  level: CalendarLevel;
}

export interface CalendarYear {
  year: number;
  /** The year's days inside the span, in order. A partial year has fewer. */
  days: CalendarDay[];
  /** Columns the whole year spans (54 only for a leap year that starts on a Sunday). */
  weeks: number;
  /** Each month with days in the span, at the column of its first such day. */
  months: { month: number; week: number }[];
  movingSec: number;
  activeDays: number;
}

/**
 * One calendar per year touched by the inclusive span [fromTs, toTs], newest first.
 * Only days inside the span get cells, so a range starting in October draws its
 * first year from October.
 */
export function activityCalendar(
  features: readonly ActivityFeature[],
  fromTs: number,
  toTs: number,
): CalendarYear[] {
  if (toTs < fromTs) return [];
  const byDay = new Map<number, { movingSec: number; count: number }>();
  for (const f of features) {
    const day = Math.floor(f.properties.ts / DAY_SEC);
    const entry = byDay.get(day) ?? { movingSec: 0, count: 0 };
    entry.movingSec += f.properties.moving_time;
    entry.count += 1;
    byDay.set(day, entry);
  }

  const firstDay = Math.floor(fromTs / DAY_SEC);
  const lastDay = Math.floor(toTs / DAY_SEC);
  const years: CalendarYear[] = [];
  for (let year = utcYear(lastDay); year >= utcYear(firstDay); year--) {
    const jan1 = Date.UTC(year, 0, 1) / 1000 / DAY_SEC;
    const dec31 = Date.UTC(year + 1, 0, 1) / 1000 / DAY_SEC - 1;
    // Monday-first weekday of Jan 1, which shifts every later day's grid position.
    const offset = (new Date(jan1 * DAY_SEC * 1000).getUTCDay() + 6) % 7;

    const cal: CalendarYear = {
      year,
      days: [],
      weeks: Math.floor((dec31 - jan1 + offset) / 7) + 1,
      months: [],
      movingSec: 0,
      activeDays: 0,
    };
    for (let day = Math.max(jan1, firstDay); day <= Math.min(dec31, lastDay); day++) {
      const pos = day - jan1 + offset;
      const { movingSec, count } = byDay.get(day) ?? { movingSec: 0, count: 0 };
      const d: CalendarDay = {
        ts: day * DAY_SEC,
        week: Math.floor(pos / 7),
        weekday: pos % 7,
        movingSec,
        count,
        level: calendarLevel(movingSec, count),
      };
      cal.days.push(d);
      cal.movingSec += movingSec;
      if (count > 0) cal.activeDays += 1;
      const month = new Date(d.ts * 1000).getUTCMonth();
      if (cal.months.at(-1)?.month !== month) cal.months.push({ month, week: d.week });
    }
    years.push(cal);
  }
  return years;
}

function utcYear(day: number): number {
  return new Date(day * DAY_SEC * 1000).getUTCFullYear();
}
