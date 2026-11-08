import { describe, expect, test } from "vitest";
import { fitCamera, homeCamera, mercatorX, mercatorY, projector, HOME_MAX_ZOOM } from "./homeCamera";
import type { Bounds } from "./cluster";
import type { ActivityFeature } from "./types";

const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

function route(coords: [number, number][]): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      id: "s:1",
      name: "Test",
      type: "Run",
      ts: 1000,
      start_date: "2024-08-18T09:58:55Z",
      distance: 1000,
      moving_time: 300,
      elevation_gain: 10,
      channels: [],
      sources: [],
    },
  };
}

describe("mercator", () => {
  test("the origin and the antimeridian", () => {
    expect(mercatorX(0)).toBeCloseTo(0.5);
    expect(mercatorX(-180)).toBeCloseTo(0);
    expect(mercatorY(0)).toBeCloseTo(0.5);
    expect(mercatorY(45)).toBeLessThan(0.5); // north is up
  });
});

describe("fitCamera", () => {
  // Around Ljubljana, wider than tall.
  const box: Bounds = [14.3, 45.95, 14.7, 46.15];

  test("unpadded: the box's middle at the canvas center, filling the binding axis", () => {
    const cam = fitCamera(box, 800, 600, NO_PADDING, 22)!;
    const project = projector(cam, 800, 600);
    const [x0, y0] = project(box[0], box[3]);
    const [x1, y1] = project(box[2], box[1]);
    expect((x0 + x1) / 2).toBeCloseTo(400, 3);
    expect((y0 + y1) / 2).toBeCloseTo(300, 3);
    // One axis touches the edges exactly, the other fits inside.
    const fillsX = Math.abs(x1 - x0 - 800) < 1e-6;
    const fillsY = Math.abs(y1 - y0 - 600) < 1e-6;
    expect(fillsX || fillsY).toBe(true);
    expect(x1 - x0).toBeLessThanOrEqual(800 + 1e-6);
    expect(y1 - y0).toBeLessThanOrEqual(600 + 1e-6);
  });

  test("padded: the box sits centered in the free area", () => {
    const padding = { top: 90, bottom: 28, left: 348, right: 452 };
    const cam = fitCamera(box, 1400, 900, padding, 22)!;
    const project = projector(cam, 1400, 900);
    const [x0, y0] = project(box[0], box[3]);
    const [x1, y1] = project(box[2], box[1]);
    expect((x0 + x1) / 2).toBeCloseTo((348 + (1400 - 452)) / 2, 3);
    expect((y0 + y1) / 2).toBeCloseTo((90 + (900 - 28)) / 2, 3);
    expect(x0).toBeGreaterThanOrEqual(348 - 1e-6);
    expect(x1).toBeLessThanOrEqual(1400 - 452 + 1e-6);
  });

  test("caps the zoom", () => {
    const tiny: Bounds = [14.5, 46.05, 14.5001, 46.0501];
    expect(fitCamera(tiny, 800, 600, NO_PADDING, 13)!.zoom).toBe(13);
  });

  test("a single point fits at the cap", () => {
    const point: Bounds = [14.5, 46.05, 14.5, 46.05];
    const cam = fitCamera(point, 800, 600, NO_PADDING, 13)!;
    expect(cam.zoom).toBe(13);
    expect(cam.center[0]).toBeCloseTo(14.5);
    expect(cam.center[1]).toBeCloseTo(46.05);
  });

  test("no room left → null", () => {
    expect(fitCamera(box, 100, 100, { top: 60, bottom: 60, left: 0, right: 0 }, 13)).toBeNull();
  });
});

describe("homeCamera", () => {
  test("no routes → null", () => {
    expect(homeCamera([], 800, 600, { top: 62, right: 0, bottom: 0, left: 0 })).toBeNull();
  });

  test("frames the routes below the header", () => {
    const routes = [
      route([[14.4, 46.0], [14.6, 46.1]]),
      route([[14.45, 46.02], [14.55, 46.08]]),
    ];
    const cam = homeCamera(routes, 800, 600, { top: 62, right: 0, bottom: 0, left: 0 })!;
    expect(cam.zoom).toBeLessThanOrEqual(HOME_MAX_ZOOM);
    const [, y] = projector(cam, 800, 600)(14.5, 46.05);
    expect(y).toBeGreaterThan(300); // pushed down, clear of the header
  });
});
