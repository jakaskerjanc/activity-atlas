import { describe, expect, test } from "vitest";
import { cellAlpha, heatmapGrid } from "./elevationHeatmap";

describe("heatmapGrid", () => {
  test("null without profiles", () => {
    expect(heatmapGrid([], 100)).toBeNull();
  });

  test("extents: whole km, round metres, and always including the start", () => {
    const g = heatmapGrid([[0, 12, 37, 20]], 1000, 10, 10)!;
    expect(g.xMaxM).toBe(3000);
    expect(g.yMax).toBe(40);
    expect(g.yMin).toBe(0);
  });

  test("a repeated route piles up in the same cells; a one-off stays at 1", () => {
    const loop = [0, 50, 100, 50, 0];
    const other = [0, -20, -40, -20, 0];
    // 1 km long, so the routes span the whole (whole-km) axis.
    const g = heatmapGrid([loop, loop, loop, other], 250, 4, 14)!;
    expect(g.max).toBe(3);
    expect(g.profiles).toBe(4);
    expect(g.counts.filter((c) => c === 1).length).toBeGreaterThan(0);
    // Every profile passes through every column.
    for (let c = 0; c < g.cols; c++) {
      const column = Array.from({ length: g.rows }, (_, r) => g.counts[r * g.cols + c]);
      expect(column.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4);
    }
  });

  test("a steep climb fills the column between its steps", () => {
    // 0 m, then +500 m at the next column: the column is filled from one to the other.
    const g = heatmapGrid([[0, 0, 1000, 1000]], 1000, 3, 10)!;
    const middle = Array.from({ length: g.rows }, (_, r) => g.counts[r * g.cols + 1]);
    expect(middle.join("")).toBe("0000011111");
  });

  test("a point on the bottom edge is drawn in the last row", () => {
    const g = heatmapGrid([[0, 0]], 1000, 1, 4)!;
    expect(g.counts).toEqual([0, 0, 0, 1]);
  });

  test("a long axis rounds up to 5 km", () => {
    const g = heatmapGrid([Array.from({ length: 112 }, () => 0)], 100, 10, 10)!;
    expect(g.xMaxM).toBe(15000);
  });

  test("outliers beyond the quantiles are cut and counted", () => {
    const short = Array.from({ length: 30 }, () => [0, 10, 20, 10, 0]);
    const long = Array.from({ length: 200 }, (_, i) => (i < 100 ? i * 10 : (200 - i) * 10));
    const g = heatmapGrid([...short, long], 100, 20, 10)!;
    expect(g.xMaxM).toBe(1000);
    expect(g.yMax).toBe(20);
    expect(g.cut).toBe(1);
    expect(g.counts.every(Number.isFinite)).toBe(true);
  });
});

describe("cellAlpha", () => {
  test("empty is transparent, one pass faint, the busiest cell opaque", () => {
    expect(cellAlpha(0, 10)).toBe(0);
    expect(cellAlpha(1, 10)).toBeCloseTo(0.14);
    expect(cellAlpha(10, 10)).toBe(1);
    expect(cellAlpha(1, 1)).toBeCloseTo(0.14);
  });

  test("log scale: the middle of the range is well past half the way up", () => {
    expect(cellAlpha(10, 100)).toBeGreaterThan(0.5);
  });
});
