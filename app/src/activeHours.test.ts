import { describe, expect, test } from "vitest";
import { activeHours, activeHoursByWeekPart, busiestHour, localSecondOfDay, localWeekday } from "./activeHours";
import { record } from "./testFixtures";

const at = (start_local: string, elapsed_time?: number, moving_time?: number) =>
  record({ start_local, elapsed_time, moving_time });

describe("localSecondOfDay", () => {
  test("reads the wall clock, not the UTC time", () => {
    expect(localSecondOfDay("2026-11-06T17:26:30")).toBe(17 * 3600 + 26 * 60 + 30);
    expect(localSecondOfDay("2026-11-06T07:05")).toBe(7 * 3600 + 5 * 60);
    expect(localSecondOfDay(undefined)).toBeNull();
    expect(localSecondOfDay("2026-11-06")).toBeNull();
  });
});

describe("activeHours", () => {
  test("an activity inside one hour adds only to that hour", () => {
    const h = activeHours([at("2026-01-01T18:10:00", 1800)]);
    expect(h.seconds[18]).toBe(1800);
    expect(h.total).toBe(1800);
    expect(h.activities[18]).toBe(1);
    expect(h.seconds.filter((s) => s > 0)).toHaveLength(1);
  });

  test("a long activity fills every hour it covers", () => {
    const h = activeHours([at("2026-01-01T09:30:00", 3 * 3600)]);
    expect(h.seconds.slice(9, 13)).toEqual([1800, 3600, 3600, 1800]);
    expect(h.activities.slice(9, 13)).toEqual([1, 1, 1, 1]);
  });

  test("wraps past midnight", () => {
    const h = activeHours([at("2026-01-01T23:00:00", 2 * 3600)]);
    expect(h.seconds[23]).toBe(3600);
    expect(h.seconds[0]).toBe(3600);
  });

  test("counts an activity once per hour even past a full day", () => {
    const h = activeHours([at("2026-01-01T06:00:00", 25 * 3600)]);
    expect(h.seconds[6]).toBe(7200);
    expect(h.activities[6]).toBe(1);
    expect(h.total).toBe(25 * 3600);
  });

  test("uses moving time without elapsed time, and skips what has neither", () => {
    const h = activeHours([
      at("2026-01-01T08:00:00", undefined, 600),
      at("2026-01-01T08:00:00"),
      record({ start_local: undefined, elapsed_time: 600 }),
    ]);
    expect(h.seconds[8]).toBe(600);
    expect(h.skipped).toBe(2);
  });
});

describe("busiestHour", () => {
  test("picks the hour with the most time, none without time", () => {
    expect(busiestHour(activeHours([at("2026-01-01T07:00:00", 1800), at("2026-01-01T18:00:00", 5400)]))).toBe(18);
    expect(busiestHour(activeHours([]))).toBeNull();
  });
});

describe("activeHoursByWeekPart", () => {
  test("splits by the local start date's weekday", () => {
    expect(localWeekday("2026-11-06T23:30:00")).toBe(4); // a Friday
    expect(localWeekday("2026-11-08T08:00:00")).toBe(6); // a Sunday
    expect(localWeekday(undefined)).toBeNull();
    const s = activeHoursByWeekPart([
      at("2026-11-06T18:00:00", 3600), // Friday evening
      at("2026-11-07T10:00:00", 7200), // Saturday morning
      record({ start_local: undefined, elapsed_time: 600 }),
      at("2026-11-08T10:00:00"), // Sunday, no duration
    ]);
    expect(s.weekdays.seconds[18]).toBe(3600);
    expect(s.weekdays.total).toBe(3600);
    expect(s.weekends.seconds.slice(10, 12)).toEqual([3600, 3600]);
    expect(s.skipped).toBe(2);
  });
});
