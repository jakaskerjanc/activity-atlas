import { describe, expect, test } from "vitest";
import {
  climbingRidgeline,
  daysInMonth,
  formatGain,
  POINTS_PER_DAY,
  ridgeHeight,
  ridgeLabel,
  ridgePaths,
  smoothDaily,
  type MonthRidge,
} from "./ridgeline";
import { median, quantile } from "./stats";
import { record } from "./testFixtures";

const at = (iso: string) => Date.parse(iso) / 1000;
const month = (year: number, m: number) => year * 12 + (m - 1);

describe("median and quantile", () => {
  test("median of odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("nearest-rank quantile", () => {
    expect(quantile([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([5, 1, 3, 2, 4], 1)).toBe(5);
  });
});

describe("daysInMonth", () => {
  test("lengths, leap years included", () => {
    expect(daysInMonth(month(2024, 1))).toBe(31);
    expect(daysInMonth(month(2024, 2))).toBe(29);
    expect(daysInMonth(month(2025, 2))).toBe(28);
    expect(daysInMonth(month(2025, 4))).toBe(30);
  });
});

describe("smoothDaily", () => {
  test("a lone day peaks at its own gain, in the middle of the day", () => {
    const curve = smoothDaily([0, 0, 500, 0, 0]);
    expect(curve).toHaveLength(5 * POINTS_PER_DAY + 1);
    // Day 3 (index 2) runs from 2 to 3 days in; its middle, 2.5, is a sample point.
    expect(Math.max(...curve)).toBe(500);
    expect(curve.indexOf(500)).toBe(2.5 * POINTS_PER_DAY);
  });

  test("no gain, no height", () => {
    expect(smoothDaily([0, 0, 0]).every((v) => v === 0)).toBe(true);
  });
});

describe("climbingRidgeline", () => {
  const act = (id: string, iso: string, gain?: number) =>
    record({ id, ts: at(iso), elevation_gain: gain });

  test("one ridge per month of the range, oldest first, empty months included", () => {
    const { ridges } = climbingRidgeline(
      [act("b", "2024-03-31T23:00:00Z", 50), act("a", "2024-01-10T08:00:00Z", 100)],
      month(2024, 1),
      month(2024, 3),
    );
    expect(ridges.map((r) => r.month)).toEqual([month(2024, 1), month(2024, 2), month(2024, 3)]);
    expect(ridges.map((r) => r.days)).toEqual([31, 29, 31]);
    expect(ridges.map((r) => r.count)).toEqual([1, 0, 1]);
    expect(ridges[1]).toMatchObject({ gainM: undefined, curve: null, activeDays: [] });
  });

  test("gain is summed per UTC day; days with an activity are marked, gain or not", () => {
    const [ridge] = climbingRidgeline(
      [
        act("a", "2024-01-10T06:00:00Z", 100),
        act("b", "2024-01-10T18:00:00Z", 250),
        act("c", "2024-01-31T23:59:59Z", 40),
        act("gym", "2024-01-02T07:00:00Z"),
      ],
      month(2024, 1),
      month(2024, 1),
    ).ridges;
    expect(ridge.daily[9]).toBe(350);
    expect(ridge.daily[30]).toBe(40);
    expect(ridge.daily[1]).toBe(0);
    expect(ridge.activeDays).toEqual([2, 10, 31]);
    expect(ridge).toMatchObject({ count: 4, gainM: 390, biggestDay: { day: 10, gainM: 350 } });
    expect(ridge.curve).toHaveLength(31 * POINTS_PER_DAY + 1);
  });

  test("a month whose activities have no known gain has no curve", () => {
    const [ridge] = climbingRidgeline(
      [act("gym", "2024-01-02T07:00:00Z")],
      month(2024, 1),
      month(2024, 1),
    ).ridges;
    expect(ridge).toMatchObject({ gainM: undefined, curve: null, biggestDay: undefined });
    expect(ridge.activeDays).toEqual([2]);
  });

  test("the shared scale is the highest point of any ridge", () => {
    const { ridges, maxM } = climbingRidgeline(
      [act("big", "2024-01-10T08:00:00Z", 1500), act("small", "2024-02-10T08:00:00Z", 100)],
      month(2024, 1),
      month(2024, 2),
    );
    expect(maxM).toBe(Math.max(...ridges[0].curve!));
    expect(Math.max(...ridges[1].curve!)).toBeCloseTo(maxM / 15);
  });
});

describe("ridge geometry", () => {
  test("square-root scale shared by every row", () => {
    expect(ridgeHeight(400, 400, 80)).toBe(80);
    expect(ridgeHeight(100, 400, 80)).toBe(40);
    expect(ridgeHeight(0, 400, 80)).toBe(0);
    expect(ridgeHeight(10, 0, 80)).toBe(0);
  });

  test("a short month's ridge ends before the axis does", () => {
    const feb = new Array(28 * POINTS_PER_DAY + 1).fill(0);
    const { area } = ridgePaths(feb, 310, 1, 40);
    expect(area.endsWith("L280,0L0,0Z")).toBe(true);
  });

  test("paths with the baseline at y = 0, nothing without a curve", () => {
    const curve = [0, 100, 25, 0, 0];
    const { line } = ridgePaths(curve, 31 * POINTS_PER_DAY, 100, 40);
    expect(line.startsWith("M0,0L1,-40L2,-20")).toBe(true);
    expect(ridgePaths(null, 200, 100, 40)).toEqual({ line: "", area: "" });
  });
});

describe("labels", () => {
  test("gain", () => {
    expect(formatGain(undefined)).toBe("—");
    expect(formatGain(816.6)).toBe("817 m");
    expect(formatGain(18240)).toBe("18.2k m");
  });

  test("accessible row name", () => {
    const base: MonthRidge = {
      month: month(2026, 8),
      days: 31,
      count: 0,
      gainM: undefined,
      daily: [],
      activeDays: [],
      biggestDay: undefined,
      curve: null,
    };
    expect(
      ridgeLabel({ ...base, count: 23, gainM: 3817, biggestDay: { day: 14, gainM: 1204 } }),
    ).toBe("August 2026 · 23 activities · 3,817 m gain · biggest day Aug 14, 2026: 1,204 m");
    expect(ridgeLabel({ ...base, count: 1 })).toBe(
      "August 2026 · 1 activity · elevation gain unknown",
    );
    expect(ridgeLabel(base)).toBe("August 2026 · no activities");
  });
});

describe("smoothing is honest about which days had climbing", () => {
  test("a lone day's bell is all but gone by the middle of the next day", () => {
    const curve = smoothDaily([0, 0, 1000, 0, 0]);
    // Middle of day 4 (index 3.5 days) and day 2 (1.5 days).
    expect(curve[3.5 * POINTS_PER_DAY]).toBeLessThan(10);
    expect(curve[1.5 * POINTS_PER_DAY]).toBeLessThan(10);
  });

  test("each day lists its activities for the tooltip", () => {
    const { ridges } = climbingRidgeline(
      [record({ id: "a", name: "Morning hike", ts: at("2024-08-18T07:00:00Z"), elevation_gain: 640 })],
      month(2024, 8),
      month(2024, 8),
    );
    expect(ridges[0].byDay?.[17]).toEqual([{ id: "a", name: "Morning hike", type: "Run", gainM: 640 }]);
  });
});
