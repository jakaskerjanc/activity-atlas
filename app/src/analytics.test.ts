import { describe, expect, test } from "vitest";
import { activityCalendar, calendarLevel, consistency, consistencyCards } from "./analytics";
import { record } from "./testFixtures";

/** Epoch seconds for a UTC wall-clock time in August 2024. */
const aug = (day: number, hour = 10, minute = 0) => Date.UTC(2024, 7, day, hour, minute) / 1000;

// A two-week span: Aug 1 00:00 through Aug 14 23:59:59 UTC.
const FROM = aug(1, 0);
const TO = aug(15, 0) - 1;

describe("consistency", () => {
  test("counts each UTC day with an activity once", () => {
    const c = consistency(
      [record({ ts: aug(1, 8) }), record({ ts: aug(1, 18) }), record({ ts: aug(3) })],
      FROM,
      TO,
    );
    expect(c.activeDays).toBe(2);
  });

  test("splits days at UTC midnight", () => {
    const c = consistency(
      [record({ ts: aug(1, 23, 30) }), record({ ts: aug(2, 0, 30) })],
      FROM,
      TO,
    );
    expect(c.activeDays).toBe(2);
    expect(c.longestStreak).toBe(2);
  });

  test("longest streak is the longest run of consecutive active days, in any order", () => {
    const days = [6, 1, 5, 2, 3];
    const c = consistency(
      days.map((d) => record({ ts: aug(d) })),
      FROM,
      TO,
    );
    expect(c.longestStreak).toBe(3);
  });

  test("averages activities and distance per week over the span", () => {
    const c = consistency(
      [
        record({ ts: aug(1), distance: 10000 }),
        record({ ts: aug(4), distance: 10000 }),
        record({ ts: aug(8), distance: 10000 }),
        record({ ts: aug(12), distance: 10000 }),
      ],
      FROM,
      TO,
    );
    expect(c.activitiesPerWeek).toBe(2);
    expect(c.distancePerWeekM).toBe(20000);
  });

  test("a span shorter than a week counts as one week", () => {
    const c = consistency([record({ ts: aug(1), distance: 5000 })], aug(1, 0), aug(3, 0));
    expect(c.activitiesPerWeek).toBe(1);
    expect(c.distancePerWeekM).toBe(5000);
  });

  test("no activities: zero counts and an unknown distance, as the totals' dash", () => {
    expect(consistency([], FROM, TO)).toEqual({
      activeDays: 0,
      longestStreak: 0,
      activitiesPerWeek: 0,
      distancePerWeekM: undefined,
    });
  });

  test("distance per week sums only the known distances", () => {
    const c = consistency(
      [record({ ts: aug(1), distance: 14000 }), record({ ts: aug(2), distance: undefined })],
      FROM,
      TO,
    );
    expect(c.activitiesPerWeek).toBe(1);
    expect(c.distancePerWeekM).toBe(7000);
  });

  test("distance per week is unknown when no activity has a distance", () => {
    const c = consistency([record({ ts: aug(1), distance: undefined })], FROM, TO);
    expect(c.distancePerWeekM).toBeUndefined();
    expect(consistencyCards(c)[1]).toEqual({ value: "—", unit: "km", label: "Distance per week", accent: true });
  });
});

describe("consistencyCards", () => {
  test("mirrors the totals layout: per-week averages on top, days below", () => {
    const cards = consistencyCards({
      activeDays: 143,
      longestStreak: 12,
      activitiesPerWeek: 2.94,
      distancePerWeekM: 39420,
    });
    expect(cards).toEqual([
      { value: "2.9", label: "Activities per week" },
      { value: "39.4", unit: "km", label: "Distance per week", accent: true },
      { value: "143", label: "Active days" },
      { value: "12", unit: "days", label: "Longest streak" },
    ]);
  });

  test("a one-day streak reads in the singular", () => {
    const cards = consistencyCards({
      activeDays: 1,
      longestStreak: 1,
      activitiesPerWeek: 1,
      distancePerWeekM: 0,
    });
    expect(cards[3]).toEqual({ value: "1", unit: "day", label: "Longest streak" });
  });
});

/** Epoch seconds for a UTC date (month is 1-based here, for readability). */
const utc = (year: number, month: number, day: number, hour = 10) =>
  Date.UTC(year, month - 1, day, hour) / 1000;
const dayStart = (year: number, month: number, day: number) => utc(year, month, day, 0);
const yearSpan = (year: number): [number, number] => [
  dayStart(year, 1, 1),
  dayStart(year + 1, 1, 1) - 1,
];

describe("calendarLevel", () => {
  test("steps at 1, 2 and 4 hours of moving time", () => {
    expect(calendarLevel(0, 0)).toBe(0);
    expect(calendarLevel(3599, 1)).toBe(1);
    expect(calendarLevel(3600, 1)).toBe(2);
    expect(calendarLevel(7200, 1)).toBe(3);
    expect(calendarLevel(14400, 1)).toBe(4);
  });

  test("a day with an activity never reads as empty, even with no moving time", () => {
    expect(calendarLevel(0, 1)).toBe(1);
  });

  test("a day whose moving time is unknown is still an active day", () => {
    expect(calendarLevel(undefined, 1)).toBe(1);
  });
});

describe("activityCalendar", () => {
  test("sums moving time and counts activities per UTC day", () => {
    const [year] = activityCalendar(
      [
        record({ ts: utc(2024, 8, 18, 8), moving_time: 3000 }),
        record({ ts: utc(2024, 8, 18, 18), moving_time: 1800 }),
      ],
      ...yearSpan(2024),
    );
    const day = year.days.find((d) => d.ts === dayStart(2024, 8, 18));
    expect(day).toMatchObject({ movingSec: 4800, count: 2, level: 2 });
    expect(year.days.filter((d) => d.count > 0)).toHaveLength(1);
  });

  test("lays out weeks as columns starting on Monday", () => {
    // 2024 starts on a Monday; 2023 on a Sunday.
    const [y2024] = activityCalendar([], ...yearSpan(2024));
    const at = (d: number) => y2024.days[d - 1];
    expect(at(1)).toMatchObject({ week: 0, weekday: 0 });
    expect(at(7)).toMatchObject({ week: 0, weekday: 6 });
    expect(at(8)).toMatchObject({ week: 1, weekday: 0 });
    expect(y2024.days).toHaveLength(366);
    expect(y2024.weeks).toBe(53);

    const [y2023] = activityCalendar([], ...yearSpan(2023));
    expect(y2023.days[0]).toMatchObject({ week: 0, weekday: 6 });
    expect(y2023.days[1]).toMatchObject({ week: 1, weekday: 0 });
  });

  test("covers only the span, one entry per year, newest first", () => {
    const years = activityCalendar([], dayStart(2023, 10, 1), dayStart(2024, 2, 10) + 3600);
    expect(years.map((y) => y.year)).toEqual([2024, 2023]);
    expect(years[0].days).toHaveLength(31 + 10);
    expect(years[1].days).toHaveLength(31 + 30 + 31);
    expect(years[1].days[0].ts).toBe(dayStart(2023, 10, 1));
  });

  test("places a label for each month in the span at the column of its first day", () => {
    const [full] = activityCalendar([], ...yearSpan(2024));
    expect(full.months).toHaveLength(12);
    // Feb 1, 2024 is day 31 after a Monday Jan 1: column 4.
    expect(full.months[1]).toEqual({ month: 1, week: 4 });

    const [partial] = activityCalendar([], dayStart(2023, 10, 1), dayStart(2024, 1, 1) - 1);
    expect(partial.months.map((m) => m.month)).toEqual([9, 10, 11]);
  });

  test("totals moving time and active days per year", () => {
    const years = activityCalendar(
      [
        record({ ts: utc(2024, 1, 5), moving_time: 3600 }),
        record({ ts: utc(2024, 1, 5), moving_time: 600 }),
        record({ ts: utc(2024, 3, 1), moving_time: 1200 }),
        record({ ts: utc(2023, 12, 31), moving_time: 900 }),
      ],
      dayStart(2023, 12, 1),
      dayStart(2024, 4, 1) - 1,
    );
    expect(years.map(({ year, movingSec, activeDays }) => ({ year, movingSec, activeDays }))).toEqual([
      { year: 2024, movingSec: 5400, activeDays: 2 },
      { year: 2023, movingSec: 900, activeDays: 1 },
    ]);
  });

  test("skips unknown moving times instead of counting them as zero", () => {
    const [year] = activityCalendar(
      [
        record({ ts: utc(2024, 8, 18, 8), moving_time: 5000 }),
        record({ ts: utc(2024, 8, 18, 18), moving_time: undefined }),
        record({ ts: utc(2024, 8, 20), moving_time: undefined }),
      ],
      ...yearSpan(2024),
    );
    const day = (d: number) => year.days.find((x) => x.ts === dayStart(2024, 8, d));
    expect(day(18)).toMatchObject({ movingSec: 5000, count: 2, level: 2 });
    expect(day(20)).toMatchObject({ movingSec: undefined, count: 1, level: 1 });
    expect(day(19)).toMatchObject({ movingSec: 0, count: 0, level: 0 });
    expect(year).toMatchObject({ movingSec: 5000, activeDays: 2 });
  });

  test("a year whose active days all lack a moving time has an unknown total", () => {
    const [year] = activityCalendar(
      [record({ ts: utc(2024, 8, 20), moving_time: undefined })],
      ...yearSpan(2024),
    );
    expect(year).toMatchObject({ movingSec: undefined, activeDays: 1 });
  });

  test("lists each day's activities by name and moving time, earliest first", () => {
    const [year] = activityCalendar(
      [
        record({ id: "b", name: "Evening walk", ts: utc(2024, 8, 18, 18), moving_time: undefined }),
        record({ id: "a", name: "Morning run", ts: utc(2024, 8, 18, 8), moving_time: 3000 }),
      ],
      ...yearSpan(2024),
    );
    const day = (d: number) => year.days.find((x) => x.ts === dayStart(2024, 8, d))!;
    expect(day(18).activities).toEqual([
      { id: "a", name: "Morning run", movingSec: 3000 },
      { id: "b", name: "Evening walk", movingSec: undefined },
    ]);
    expect(day(19).activities).toEqual([]);
  });

  test("an empty span has no years", () => {
    expect(activityCalendar([], 1000, 999)).toEqual([]);
  });
});
