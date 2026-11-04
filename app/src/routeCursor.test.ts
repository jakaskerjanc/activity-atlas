import { describe, expect, test } from "vitest";
import { cursorLngLat, markerPoint, nearestSample } from "./routeCursor";
import type { DetailFile } from "./types";

const detail: DetailFile = {
  v: 1,
  step: 5,
  t: [0, 5, 10, 15],
  lat: [46.0, 46.001, null, 46.003],
  lon: [14.0, 14.001, null, 14.003],
  hr: [100, 101, 102, 103],
};

describe("cursorLngLat", () => {
  test("returns [lon, lat]", () => {
    expect(cursorLngLat(detail, 1)).toEqual([14.001, 46.001]);
  });

  test("is null at a sample without a position", () => {
    expect(cursorLngLat(detail, 2)).toBeNull();
  });

  test("is null without a cursor or GPS", () => {
    expect(cursorLngLat(detail, null)).toBeNull();
    expect(cursorLngLat({ v: 1, step: 5, t: [0], hr: [1] }, 0)).toBeNull();
  });
});

describe("nearestSample", () => {
  test("finds the closest sample", () => {
    expect(nearestSample(detail, 14.0011, 46.0009)).toBe(1);
    expect(nearestSample(detail, 13.9, 45.9)).toBe(0);
  });

  test("skips null positions", () => {
    expect(nearestSample(detail, 14.002, 46.002)).not.toBe(2);
  });

  test("is null without GPS", () => {
    expect(nearestSample({ v: 1, step: 5, t: [0], hr: [1] }, 14, 46)).toBeNull();
  });
});

describe("markerPoint", () => {
  test("is the cursor position while the route is on the map", () => {
    expect(markerPoint(detail, 1, true)).toEqual([14.001, 46.001]);
  });

  test("is null when the selected route is filtered out (#17)", () => {
    expect(markerPoint(detail, 1, false)).toBeNull();
  });

  test("is null before the detail loads", () => {
    expect(markerPoint(null, 1, true)).toBeNull();
  });
});
