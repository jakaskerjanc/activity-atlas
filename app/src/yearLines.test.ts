import { describe, expect, test } from "vitest";
import { formatMeasure, formatRefDay, refDayOf, valueOn, yearComparison, yearLines } from "./yearLines";
import { record } from "./testFixtures";

const ts = (iso: string) => Date.parse(iso) / 1000;
const run = (iso: string, distance: number | undefined, id = iso) =>
  record({ id, ts: ts(iso), start_date: iso, distance });

const FROM = ts("2023-01-01T00:00:00Z");
const END = ts("2024-03-10T12:00:00Z");

describe("yearLines", () => {
  test("one line per year, each a running total by day", () => {
    const lines = yearLines(
      [run("2023-01-02T08:00:00Z", 5000), run("2023-01-02T18:00:00Z", 3000), run("2023-12-31T08:00:00Z", 2000), run("2024-01-01T08:00:00Z", 7000)],
      FROM,
      END,
      "distance",
    );
    expect(lines.map((l) => l.year)).toEqual([2023, 2024]);
    const [y23, y24] = lines;
    expect([y23.fromDay, y23.toDay]).toEqual([0, 365]);
    expect(valueOn(y23, 0)).toBe(0);
    expect(valueOn(y23, 1)).toBe(8000);
    expect(valueOn(y23, 364)).toBe(8000);
    expect(valueOn(y23, 365)).toBe(10000);
    expect(y23.total).toBe(10000);
    // The newest year stops on the range's last day.
    expect(y24.toDay).toBe(refDayOf(2, 10));
    expect(valueOn(y24, 0)).toBe(7000);
    expect(valueOn(y24, y24.toDay + 1)).toBeUndefined();
  });

  test("1 March lines up across leap and ordinary years", () => {
    const lines = yearLines([run("2023-03-01T08:00:00Z", 1000), run("2024-03-01T08:00:00Z", 1000)], FROM, END, "distance");
    const day = refDayOf(2, 1);
    expect(day).toBe(60);
    expect(lines.map((l) => [valueOn(l, day - 1), valueOn(l, day)])).toEqual([
      [0, 1000],
      [0, 1000],
    ]);
  });

  test("the first year starts where the date range does", () => {
    const from = ts("2023-10-01T00:00:00Z");
    const [y23] = yearLines([run("2023-10-23T08:00:00Z", 4000)], from, END, "distance");
    expect(y23.fromDay).toBe(refDayOf(9, 1));
    expect(valueOn(y23, y23.fromDay - 1)).toBeUndefined();
    expect(y23.total).toBe(4000);
  });

  test("leaves out activities without the measure, and keeps an empty year between", () => {
    const end = ts("2025-02-01T00:00:00Z");
    const lines = yearLines(
      [run("2023-05-01T08:00:00Z", 4000), run("2023-06-01T08:00:00Z", undefined), run("2025-01-05T08:00:00Z", 1000)],
      FROM,
      end,
      "distance",
    );
    expect(lines.map((l) => [l.year, l.total])).toEqual([
      [2023, 4000],
      [2024, 0],
      [2025, 1000],
    ]);
    expect(yearLines([run("2023-06-01T08:00:00Z", undefined)], FROM, END, "distance")).toEqual([]);
  });

  test("measures climbing and moving time too", () => {
    const a = record({ ts: ts("2024-01-05T08:00:00Z"), elevation_gain: 250, moving_time: 5400 });
    expect(yearLines([a], FROM, END, "climbing")[0].total).toBe(250);
    expect(yearLines([a], FROM, END, "time")[0].total).toBe(5400);
  });
});

describe("yearComparison", () => {
  test("reads the year before on the newest year's last day", () => {
    const lines = yearLines(
      [run("2023-02-01T08:00:00Z", 5000), run("2023-08-01T08:00:00Z", 9000), run("2024-03-01T08:00:00Z", 7000)],
      FROM,
      END,
      "distance",
    );
    expect(yearComparison(lines)).toEqual({ year: 2024, day: refDayOf(2, 10), value: 7000, against: 2023, againstValue: 5000 });
  });

  test("is null with one year, or when the year before starts mid-year", () => {
    expect(yearComparison(yearLines([run("2024-01-05T08:00:00Z", 1000)], FROM, END, "distance"))).toBeNull();
    const from = ts("2023-10-01T00:00:00Z");
    const lines = yearLines([run("2023-10-23T08:00:00Z", 4000), run("2024-01-05T08:00:00Z", 1000)], from, END, "distance");
    expect(yearComparison(lines)).toBeNull();
  });
});

test("formats days and measures", () => {
  expect(formatRefDay(refDayOf(10, 15))).toBe("Nov 15");
  expect(formatRefDay(59)).toBe("Feb 29");
  expect(formatMeasure(1812400, "distance")).toBe("1,812 km");
  expect(formatMeasure(24310.4, "climbing")).toBe("24,310 m");
  expect(formatMeasure(9.26 * 3600, "time")).toBe("9.3 h");
  expect(formatMeasure(182.4 * 3600, "time")).toBe("182 h");
});
