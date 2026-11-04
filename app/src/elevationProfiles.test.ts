import { describe, expect, test } from "vitest";
import { elevationAt, nearestLine, profileChart, type ProfileLine } from "./elevationProfiles";

const line = (id: string, profile: number[], type = "Run"): ProfileLine => ({
  id,
  name: id,
  type,
  ts: 0,
  profile,
});

describe("profileChart", () => {
  test("null without lines", () => {
    expect(profileChart([], 100)).toBeNull();
  });

  test("extents: whole km, round metres, always including the start", () => {
    const c = profileChart([line("a", [0, 12, 37, 20])], 1000)!;
    expect(c).toMatchObject({ xMaxM: 3000, yMax: 40, yMin: 0, cut: 0 });
  });

  test("a long axis rounds up to 5 km", () => {
    expect(profileChart([line("a", new Array(112).fill(0))], 100)!.xMaxM).toBe(15000);
  });

  test("outliers beyond the quantiles run off the chart and are counted", () => {
    const short = Array.from({ length: 30 }, (_, i) => line(`s${i}`, [0, 10, 20, 10, 0]));
    const long = line("long", Array.from({ length: 200 }, (_, i) => (i < 100 ? i * 10 : (200 - i) * 10)));
    const c = profileChart([...short, long], 100)!;
    expect(c).toMatchObject({ xMaxM: 1000, yMax: 20, cut: 1 });
    expect(c.lines).toHaveLength(31);
  });
});

describe("elevationAt", () => {
  test("interpolates between points, undefined past the end", () => {
    expect(elevationAt([0, 100, 50], 100, 50)).toBe(50);
    expect(elevationAt([0, 100, 50], 100, 200)).toBe(50);
    expect(elevationAt([0, 100, 50], 100, 201)).toBeUndefined();
    expect(elevationAt([0, 100, 50], 100, -1)).toBeUndefined();
  });
});

describe("nearestLine", () => {
  const chart = profileChart(
    [line("flat", [0, 0, 0, 0]), line("hill", [0, 100, 200, 100]), line("short", [0, 50])],
    100,
  )!;

  test("the closest line at that distance, within the tolerance", () => {
    expect(nearestLine(chart, 200, 190, 20)).toBe(1);
    expect(nearestLine(chart, 200, 5, 20)).toBe(0);
    expect(nearestLine(chart, 200, 100, 20)).toBeNull();
  });

  test("lines that end before the pointer don't count", () => {
    expect(nearestLine(chart, 100, 50, 10)).toBe(2);
    expect(nearestLine(chart, 300, 40, 60)).toBe(0);
  });
});
