import { describe, expect, test } from "vitest";
import {
  density,
  formatGain,
  hilliness,
  hillinessRidgeline,
  ridgeLabel,
  ridgePaths,
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

describe("hilliness", () => {
  test("metres climbed per km", () => {
    expect(hilliness(record({ distance: 8000, elevation_gain: 400 }))).toBe(50);
    expect(hilliness(record({ distance: 10000, elevation_gain: 0 }))).toBe(0);
  });

  test("unknown without distance or gain, or under 1 km", () => {
    expect(hilliness(record({ distance: undefined }))).toBeUndefined();
    expect(hilliness(record({ elevation_gain: undefined }))).toBeUndefined();
    expect(hilliness(record({ distance: 999, elevation_gain: 30 }))).toBeUndefined();
  });
});

describe("density", () => {
  test("the area under the curve is the number of values", () => {
    const xs = Array.from({ length: 2001 }, (_, i) => i * 0.05);
    const d = density([20, 40, 60], xs, 2);
    const area = d.reduce((s, v) => s + v * 0.05, 0);
    expect(area).toBeCloseTo(3, 1);
  });

  test("values near 0 keep their weight, reflected at the axis", () => {
    const xs = Array.from({ length: 401 }, (_, i) => i * 0.05);
    const area = density([0.5], xs, 2).reduce((s, v) => s + v * 0.05, 0);
    expect(area).toBeCloseTo(1, 1);
  });
});

describe("hillinessRidgeline", () => {
  const jan = (id: string, distance?: number, gain?: number) =>
    record({ id, ts: at("2024-01-10T08:00:00Z"), distance, elevation_gain: gain });
  const mar = (id: string, distance?: number, gain?: number) =>
    record({ id, ts: at("2024-03-31T23:00:00Z"), distance, elevation_gain: gain });

  test("one ridge per month of the range, oldest first, empty months included", () => {
    const { ridges } = hillinessRidgeline(
      [mar("b", 5000, 50), jan("a", 10000, 100)],
      month(2024, 1),
      month(2024, 3),
    );
    expect(ridges.map((r) => r.month)).toEqual([month(2024, 1), month(2024, 2), month(2024, 3)]);
    expect(ridges.map((r) => r.count)).toEqual([1, 0, 1]);
    expect(ridges[1]).toMatchObject({ gainM: undefined, density: null, measured: 0 });
  });

  test("gain counts every activity; the curve only those with a hilliness", () => {
    const [ridge] = hillinessRidgeline(
      [jan("run", 10000, 50), jan("gym", undefined, 30), jan("unknown", 5000, undefined)],
      month(2024, 1),
      month(2024, 1),
    ).ridges;
    expect(ridge).toMatchObject({ count: 3, measured: 1, gainM: 80, medianMPerKm: 5 });
    expect(ridge.density).toHaveLength(96);
  });

  test("the axis ends at a round number past nearly all activities", () => {
    const flat = Array.from({ length: 60 }, (_, i) => jan(`r${i}`, 10000, 40 + i));
    const scramble = jan("x", 2000, 900);
    const { xMax } = hillinessRidgeline([...flat, scramble], month(2024, 1), month(2024, 1));
    expect(xMax).toBe(10);
    const wide = hillinessRidgeline(
      Array.from({ length: 10 }, (_, i) => jan(`h${i}`, 10000, 300 + i * 100)),
      month(2024, 1),
      month(2024, 1),
    );
    expect(wide.xMax).toBe(120);
  });

  test("a busy month's ridge is taller than a quiet one's, on one scale", () => {
    const busy = Array.from({ length: 6 }, (_, i) => jan(`b${i}`, 10000, 50));
    const { ridges, maxDensity } = hillinessRidgeline(
      [...busy, mar("q", 10000, 50)],
      month(2024, 1),
      month(2024, 3),
    );
    expect(Math.max(...ridges[0].density!)).toBe(maxDensity);
    expect(Math.max(...ridges[2].density!)).toBeCloseTo(maxDensity / 6);
  });
});

describe("ridge geometry", () => {
  test("paths span the width with the baseline at y = 0", () => {
    const { line, area } = ridgePaths([0, 2, 1], 200, 2, 40);
    expect(line).toBe("M0,0L100,-40L200,-20");
    expect(area).toBe("M0,0L100,-40L200,-20L200,0L0,0Z");
  });

  test("no NaN when nothing has height, no path without a curve", () => {
    expect(ridgePaths([0, 0], 100, 0, 40).line).toBe("M0,0L100,0");
    expect(ridgePaths(null, 200, 1, 40)).toEqual({ line: "", area: "" });
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
      count: 0,
      measured: 0,
      gainM: undefined,
      medianMPerKm: undefined,
      density: null,
    };
    expect(ridgeLabel({ ...base, count: 23, gainM: 3817, medianMPerKm: 11.6 })).toBe(
      "August 2026 · 23 activities · 3,817 m gain · median 12 m/km",
    );
    expect(ridgeLabel({ ...base, count: 1 })).toBe(
      "August 2026 · 1 activity · elevation gain unknown",
    );
    expect(ridgeLabel(base)).toBe("August 2026 · no activities");
  });
});
