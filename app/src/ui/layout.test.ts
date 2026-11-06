// Fit padding must always leave a usable map: Mapbox's cameraForBounds returns nothing
// (so the camera never moves) once padding consumes the viewport. And it must keep a
// fitted route out from under every panel, at the panels' real sizes.

import { describe, expect, test } from "vitest";
import {
  chromeInsets,
  DETAIL_PANEL_CLEARANCE,
  FIT_EDGE,
  fitOffset,
  fitPadding,
  HEADER_HEIGHT,
  insetsKey,
  PANEL_BOTTOM,
  SIDE_PANEL_CLEARANCE,
  type Insets,
} from "./layout";

const none: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

describe("chromeInsets", () => {
  test("desktop: the open filters panel on the left, the detail panel on the right", () => {
    expect(chromeInsets({ mobile: false, sideOpen: true, detailOpen: true, bottomPanel: 0 })).toEqual({
      top: HEADER_HEIGHT,
      left: SIDE_PANEL_CLEARANCE,
      right: DETAIL_PANEL_CLEARANCE,
      bottom: 0,
    });
  });

  test("desktop: collapsed panels give their side back; the replay bar takes the bottom", () => {
    expect(chromeInsets({ mobile: false, sideOpen: false, detailOpen: false, bottomPanel: 150 })).toEqual({
      top: HEADER_HEIGHT,
      left: 0,
      right: 0,
      bottom: 150 + PANEL_BOTTOM,
    });
  });

  test("phone: the sheet's measured height covers the bottom, whatever its state", () => {
    // The old fit assumed an 80px bottom strip while the sheet with charts stood ~430px.
    const i = chromeInsets({ mobile: true, sideOpen: true, detailOpen: true, bottomPanel: 430 });
    expect(i).toEqual({ top: HEADER_HEIGHT, left: 0, right: 0, bottom: 430 });
  });
});

describe("fitPadding", () => {
  test("adds the breathing room to every covered edge", () => {
    const pad = fitPadding(1440, 900, { top: 62, left: 320, right: 424, bottom: 0 });
    expect(pad).toEqual({ top: 62 + FIT_EDGE, left: 320 + FIT_EDGE, right: 424 + FIT_EDGE, bottom: FIT_EDGE });
  });

  test("keeps a fitted route above a tall phone sheet", () => {
    const pad = fitPadding(390, 844, { top: 62, left: 0, right: 0, bottom: 430 });
    expect(pad.bottom).toBe(430 + FIT_EDGE);
    expect(844 - pad.top - pad.bottom).toBeGreaterThan(250);
  });

  test("clamps a narrow viewport instead of consuming all of it", () => {
    const pad = fitPadding(400, 900, { ...none, left: 320, right: 424 });
    expect(400 - pad.left - pad.right).toBeGreaterThanOrEqual(47.99);
  });

  test("clamps a short viewport vertically", () => {
    const pad = fitPadding(1440, 100, { ...none, top: 62 });
    expect(100 - pad.top - pad.bottom).toBeGreaterThanOrEqual(47.99);
  });

  test("adds a margin on every side, still clamped to the viewport", () => {
    expect(fitPadding(1440, 900, none, 70)).toEqual({ left: 98, right: 98, top: 98, bottom: 98 });
    const pad = fitPadding(400, 300, { ...none, left: 320 }, 70);
    expect(400 - pad.left - pad.right).toBeGreaterThanOrEqual(47.99);
    expect(300 - pad.top - pad.bottom).toBeGreaterThanOrEqual(47.99);
  });
});

describe("fitOffset", () => {
  test("shifts the center by half the difference between opposite sides", () => {
    expect(fitOffset({ left: 426, right: 24, top: 90, bottom: 80 })).toEqual([201, 5]);
    expect(fitOffset({ left: 24, right: 24, top: 80, bottom: 80 })).toEqual([0, 0]);
  });
});

describe("insetsKey", () => {
  test("ignores sub-8px jitter, so a panel's height settling doesn't refit the map", () => {
    expect(insetsKey({ ...none, bottom: 430 })).toBe(insetsKey({ ...none, bottom: 432 }));
    expect(insetsKey({ ...none, bottom: 430 })).not.toBe(insetsKey({ ...none, bottom: 90 }));
  });
});
