import { describe, expect, test } from "vitest";
import { elevationAt, elevationAxis, lineAlpha, nearestLine, profileChart, type ProfileLine } from "./elevationProfiles";

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

  test("a route past the length quantile runs off the right edge and is counted", () => {
    const short = Array.from({ length: 30 }, (_, i) => line(`s${i}`, [0, 10, 20, 10, 0]));
    const long = line("long", Array.from({ length: 200 }, () => 0));
    const c = profileChart([...short, long], 100)!;
    expect(c).toMatchObject({ xMaxM: 1000, cut: 1 });
    expect(c.lines).toHaveLength(31);
  });

  test("the y axis always fits the highest and lowest point", () => {
    const short = Array.from({ length: 30 }, (_, i) => line(`s${i}`, [0, 10, 20, 10, 0]));
    const alpine = line("alpine", [0, 900, 1934, 900, 0]);
    const valley = line("valley", [0, -40, -127, -40, 0]);
    const c = profileChart([...short, alpine, valley], 100)!;
    expect(c).toMatchObject({ yMax: 1940, yMin: -130, cut: 0 });
  });

  test("a summit past the right edge doesn't stretch the y axis", () => {
    const short = Array.from({ length: 30 }, (_, i) => line(`s${i}`, [0, 10, 20, 10, 0]));
    const longRide = line("ride", [...new Array(50).fill(5), 1500, 0]);
    const c = profileChart([...short, longRide], 100)!;
    expect(c).toMatchObject({ xMaxM: 1000, yMax: 20, cut: 1 });
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

describe("elevationAxis", () => {
  test("rounds the domain out to whole ticks, so lines never pass the top or bottom label", () => {
    // The old axis put its top tick at +800 m while lines climbed to +940 m.
    const a = elevationAxis(-130, 940, 8);
    expect(a.lo).toBeLessThanOrEqual(-130);
    expect(a.hi).toBeGreaterThanOrEqual(940);
    expect(a.ticks[0]).toBe(a.lo);
    expect(a.ticks[a.ticks.length - 1]).toBe(a.hi);
    expect(a.ticks).toContain(0);
  });

  test("fits the extent snugly: an 840 m top ends at 900, not 1000", () => {
    // A 380px plot fits 12 labelled ticks (one per ~32px).
    const a = elevationAxis(-120, 840, 12);
    expect(a.hi).toBe(900);
    expect(a.ticks.length).toBeLessThanOrEqual(12);
  });

  test("a flat set still gets a usable axis", () => {
    const a = elevationAxis(0, 0);
    expect(a.hi).toBeGreaterThan(a.lo);
  });
});

describe("lineAlpha", () => {
  test("a few lines read solid, hundreds stay light enough to stack", () => {
    expect(lineAlpha(1)).toBeGreaterThan(0.8);
    expect(lineAlpha(5)).toBeGreaterThan(0.8);
    expect(lineAlpha(100)).toBeCloseTo(0.26, 2);
    expect(lineAlpha(1000)).toBe(0.12);
  });
});
