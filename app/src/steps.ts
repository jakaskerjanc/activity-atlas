// Daily steps (data/steps.json): Garmin's daily step totals, the only wellness value the
// site publishes. Fetched the first time the analytics page needs them, validated, and
// kept for the session; laid out on the activity calendar's own grid, so the steps
// calendar lines up with it day for day. Format: scripts/types.ts StepsFile.

import type { CalendarYear } from "./analytics";
import type { StepsFile } from "./types";

/** Wire-format version this app understands (see scripts/build-tracks.ts). */
export const STEPS_VERSION = 1;

export const STEPS_URL = `${import.meta.env.BASE_URL}data/steps.json`;

/** The daily goal the shades are measured against (Garmin's default, and the owner's). */
export const STEP_GOAL = 10_000;

/** Shade step of a day: 0 = under the goal, then 10–12k, 12–16k, 16–22k, 22k+. */
export type StepsLevel = 0 | 1 | 2 | 3 | 4;

export function stepsLevel(steps: number): StepsLevel {
  if (steps < STEP_GOAL) return 0;
  if (steps < 12_000) return 1;
  if (steps < 16_000) return 2;
  if (steps < 22_000) return 3;
  return 4;
}

/** Legend text per shade step (see stepsLevel). */
export const STEPS_LEVELS = ["Under 10k", "10–12k", "12–16k", "16–22k", "22k+"];

/** Validate a fetched steps file: known version, and a start date whenever there are days. */
export function parseSteps(json: unknown): StepsFile {
  if (json == null || typeof json !== "object") throw new Error("steps file is not an object");
  const f = json as StepsFile;
  if (f.v !== STEPS_VERSION) {
    throw new Error(`Unsupported steps version ${String(f.v)} (expected ${STEPS_VERSION})`);
  }
  if (!Array.isArray(f.steps)) throw new Error("steps file has no steps");
  if (f.steps.length > 0 && !(typeof f.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.start))) {
    throw new Error("steps file has no valid start date");
  }
  if (!f.steps.every((s) => s === null || (Number.isFinite(s) && s >= 0))) {
    throw new Error("steps file holds a value that is not a step count");
  }
  return f;
}

let cached: Promise<StepsFile> | null = null;

/** Fetch and parse once. A failed load is forgotten, so the next visit retries. */
export function loadSteps(fetchJson: (url: string) => Promise<unknown>): Promise<StepsFile> {
  if (!cached) {
    const p = fetchJson(STEPS_URL).then(parseSteps);
    p.catch(() => {
      if (cached === p) cached = null;
    });
    cached = p;
  }
  return cached;
}

const DAY_SEC = 86_400;

export interface StepsDay {
  /** 00:00 UTC of the day, epoch seconds: the activity calendar's day it sits on. */
  ts: number;
  week: number;
  weekday: number;
  steps: number;
  level: StepsLevel;
}

export interface StepsYear {
  year: number;
  /** The year's days inside the date range that have a step total, in order. */
  days: StepsDay[];
  /** Mean of those days' totals; undefined without any. */
  average: number | undefined;
  /** How many of those days reached the goal. */
  atGoal: number;
}

/**
 * The step totals on the activity calendar's grid: for each of its years, the days in
 * the date range that have a total, at the same week and weekday. Garmin's local dates
 * sit on the calendar's UTC days of the same date.
 */
export function stepsCalendar(years: readonly CalendarYear[], file: StepsFile): StepsYear[] {
  const byDay = new Map<number, number>();
  if (file.start) {
    const first = Date.parse(file.start) / 1000 / DAY_SEC;
    file.steps.forEach((s, i) => {
      if (s != null) byDay.set(first + i, s);
    });
  }
  return years.map((y) => {
    const days: StepsDay[] = [];
    for (const d of y.days) {
      const steps = byDay.get(Math.floor(d.ts / DAY_SEC));
      if (steps == null) continue;
      days.push({ ts: d.ts, week: d.week, weekday: d.weekday, steps, level: stepsLevel(steps) });
    }
    const sum = days.reduce((s, d) => s + d.steps, 0);
    return {
      year: y.year,
      days,
      average: days.length ? sum / days.length : undefined,
      atGoal: days.filter((d) => d.steps >= STEP_GOAL).length,
    };
  });
}
