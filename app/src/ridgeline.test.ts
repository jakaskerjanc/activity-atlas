import { describe, expect, test } from "vitest";
import {
  formatGain,
  median,
  monthRidges,
  ridgeHeight,
  ridgeLabel,
  ridgePaths,
} from "./ridgeline";
import { record } from "./testFixtures";

const at = (iso: string) => Date.parse(iso) / 1000;
const month = (year: number, m: number) => year * 12 + (m - 1);

describe("median", () => {
  test("odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });
});

describe("monthRidges", () => {
  const jan = (id: string, gain?: number) =>
    record({ id, ts: at("2024-01-10T08:00:00Z"), elevation_gain: gain });
  const mar = (id: string, gain?: number) =>
    record({ id, ts: at("2024-03-31T23:00:00Z"), elevation_gain: gain });

  test("one ridge per month of the range, oldest first, empty months included", () => {
    const ridges = monthRidges([mar("b", 50), jan("a", 100)], {}, month(2024, 1), month(2024, 3));
    expect(ridges.map((r) => r.month)).toEqual([month(2024, 1), month(2024, 2), month(2024, 3)]);
    expect(ridges.map((r) => r.count)).toEqual([1, 0, 1]);
    expect(ridges[1]).toMatchObject({ gainM: undefined, signature: null, relief: 0, profiled: 0 });
  });

  test("the signature is the per-point median, above its own lowest point", () => {
    const profiles = {
      a: [300, 310, 320],
      b: [300, 330, 300],
      c: [900, 990, 900], // one mountain outing doesn't drag the shape
    };
    const [ridge] = monthRidges([jan("a"), jan("b"), jan("c")], profiles, month(2024, 1), month(2024, 1));
    expect(ridge.signature).toEqual([0, 30, 20]);
    expect(ridge.relief).toBe(30);
    expect(ridge.profiled).toBe(3);
  });

  test("gain counts every activity, shapes only those with a profile", () => {
    const [ridge] = monthRidges(
      [jan("routed", 120), jan("indoor", 30), jan("unknown")],
      { routed: [400, 450] },
      month(2024, 1),
      month(2024, 1),
    );
    expect(ridge).toMatchObject({ count: 3, profiled: 1, gainM: 150, signature: [0, 50] });
  });

  test("a month whose activities have no known gain has undefined gain", () => {
    const [ridge] = monthRidges([jan("a")], {}, month(2024, 1), month(2024, 1));
    expect(ridge.gainM).toBeUndefined();
    expect(ridge.count).toBe(1);
  });

  test("activities outside the range are ignored", () => {
    const ridges = monthRidges([jan("a", 100)], { a: [1, 2] }, month(2024, 2), month(2024, 3));
    expect(ridges.every((r) => r.count === 0 && r.signature == null)).toBe(true);
  });
});

describe("ridge geometry", () => {
  test("square-root scale shared by every row", () => {
    expect(ridgeHeight(400, 400, 80)).toBe(80);
    expect(ridgeHeight(100, 400, 80)).toBe(40);
    expect(ridgeHeight(0, 400, 80)).toBe(0);
    expect(ridgeHeight(500, 400, 80)).toBe(80);
  });

  test("no NaN when nothing has relief", () => {
    expect(ridgeHeight(0, 0, 80)).toBe(0);
    expect(ridgePaths([0, 0, 0], 100, 0, 80).line).toBe("M0,0L50,0L100,0");
  });

  test("paths span the width with the baseline at y = 0", () => {
    const { line, area } = ridgePaths([0, 100, 25], 200, 100, 40);
    expect(line).toBe("M0,0L100,-40L200,-20");
    expect(area).toBe("M0,0L100,-40L200,-20L200,0L0,0Z");
  });

  test("no path without a signature", () => {
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
    const base = { month: month(2026, 8), profiled: 0, signature: null, relief: 0 };
    expect(ridgeLabel({ ...base, count: 23, gainM: 3817 })).toBe(
      "August 2026 · 23 activities · 3,817 m gain",
    );
    expect(ridgeLabel({ ...base, count: 1, gainM: undefined })).toBe(
      "August 2026 · 1 activity · elevation gain unknown",
    );
    expect(ridgeLabel({ ...base, count: 0, gainM: undefined })).toBe("August 2026 · no activities");
  });
});
