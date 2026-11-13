import { describe, expect, test } from "vitest";
import { SKETCH_MAX_ZOOM, trackSketch } from "./trackSketch";
import { projector } from "./homeCamera";

const close = (a: [number, number], b: [number, number]) => {
  expect(a[0]).toBeCloseTo(b[0], 1);
  expect(a[1]).toBeCloseTo(b[1], 1);
};

describe("trackSketch", () => {
  test("fits the track inside the padded box, centered on the short side", () => {
    // A west-east line on the equator: wide and flat.
    const s = trackSketch([[0, 0], [1, 0]], 200, 100, 10)!;
    close(s.start, [10, 50]);
    close(s.end, [190, 50]);
    expect(s.d).toBe("M10.0 50.0L190.0 50.0");
  });

  test("keeps north up", () => {
    const s = trackSketch([[0, 0], [0, 1]], 100, 100, 10)!;
    expect(s.start[1]).toBeGreaterThan(s.end[1]);
  });

  test("its camera projects the route where it was drawn, so a map image taken with it lines up", () => {
    const coords: [number, number][] = [[14.5, 46.05], [14.52, 46.07], [14.55, 46.06]];
    const s = trackSketch(coords, 320, 200, 20)!;
    const project = projector(s.camera, 320, 200);
    close(project(14.5, 46.05), s.start);
    close(project(14.55, 46.06), s.end);
  });

  test("drops points closer than the step but keeps the last", () => {
    const coords: [number, number][] = [[0, 0], [0.0001, 0], [0.0002, 0], [1, 0]];
    expect(trackSketch(coords, 200, 100, 10, 2)!.d).toBe("M10.0 50.0L190.0 50.0");
  });

  test("nothing to draw for fewer than two points; a still track sits in the middle, zoom capped", () => {
    expect(trackSketch([[14, 46]], 100, 100)).toBeNull();
    const still = trackSketch([[14, 46], [14, 46]], 100, 80)!;
    close(still.start, [50, 40]);
    expect(still.camera.zoom).toBe(SKETCH_MAX_ZOOM);
  });
});
