import { describe, expect, test } from "vitest";
import { activityCalendar } from "./analytics";
import { parseSteps, stepsCalendar, stepsLevel } from "./steps";

describe("stepsLevel", () => {
  test("splits the goal from the shades above it", () => {
    expect([9999, 10000, 11999, 12000, 15999, 16000, 21999, 22000, 66170].map(stepsLevel)).toEqual([
      0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });
});

describe("parseSteps", () => {
  test("accepts a file, and an empty one without a start", () => {
    expect(parseSteps({ v: 1, start: "2026-01-01", steps: [12000, null] }).steps).toHaveLength(2);
    expect(parseSteps({ v: 1, steps: [] }).steps).toEqual([]);
  });

  test("rejects a wrong version, a missing start or a non-count", () => {
    expect(() => parseSteps({ v: 2, steps: [] })).toThrow(/version/);
    expect(() => parseSteps({ v: 1, steps: [1] })).toThrow(/start/);
    expect(() => parseSteps({ v: 1, start: "2026-01-01", steps: ["x"] })).toThrow(/step count/);
    expect(() => parseSteps("<!doctype html>")).toThrow();
  });
});

describe("stepsCalendar", () => {
  // December 2025 through January 2026, no activities.
  const years = activityCalendar([], Date.UTC(2025, 11, 1) / 1000, Date.UTC(2026, 1, 1) / 1000 - 1);

  test("puts each total on the activity calendar's cell for that date", () => {
    const [y2026, y2025] = stepsCalendar(years, {
      v: 1,
      start: "2025-12-31",
      steps: [9000, null, 15000],
    });
    expect(y2026.year).toBe(2026);
    // Jan 1 is missing: no cell rather than a 0.
    expect(y2026.days.map((d) => [new Date(d.ts * 1000).toISOString().slice(0, 10), d.steps])).toEqual([
      ["2026-01-02", 15000],
    ]);
    const jan2 = years[0].days.find((d) => d.ts === Date.UTC(2026, 0, 2) / 1000)!;
    expect([y2026.days[0].week, y2026.days[0].weekday]).toEqual([jan2.week, jan2.weekday]);
    expect(y2025.days).toHaveLength(1);
    expect(y2025.days[0].level).toBe(0);
  });

  test("averages and counts goal days over the days with a total", () => {
    const [y2026] = stepsCalendar(years, { v: 1, start: "2026-01-01", steps: [10000, 14000, null, 9000] });
    expect(y2026.average).toBe(11000);
    expect(y2026.atGoal).toBe(2);
  });

  test("leaves out days outside the date range, and years without data are empty", () => {
    const [y2026, y2025] = stepsCalendar(years, { v: 1, start: "2026-01-31", steps: [12000, 13000] });
    expect(y2026.days).toHaveLength(1); // Feb 1 is past the range
    expect(y2025).toEqual({ year: 2025, days: [], average: undefined, atGoal: 0 });
  });
});
