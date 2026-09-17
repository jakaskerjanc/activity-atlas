// Fit padding must always leave a usable map: Mapbox's cameraForBounds returns nothing
// (so the camera never moves) once padding consumes the viewport. The old fixed
// left/right of 330/360 broke exactly that below ~690px.

import { describe, expect, test } from "vitest";
import { fitPadding, SIDE_PANEL_CLEARANCE } from "./layout";

describe("fitPadding", () => {
  test("reserves the side panel's strip when it is expanded", () => {
    const pad = fitPadding(1440, 900, true);
    expect(pad.left).toBe(SIDE_PANEL_CLEARANCE + 24);
    expect(pad.right).toBe(24);
  });

  test("uses a bare margin on both sides when the side panel is collapsed", () => {
    expect(fitPadding(1440, 900, false)).toMatchObject({ left: 24, right: 24 });
  });

  test("clamps a narrow viewport instead of consuming all of it", () => {
    const pad = fitPadding(400, 900, true);
    expect(pad.left + pad.right).toBeLessThan(400);
    expect(400 - pad.left - pad.right).toBeGreaterThanOrEqual(47.99);
  });

  test("clamps a short viewport vertically", () => {
    const pad = fitPadding(1440, 100, false);
    expect(1440 - pad.left - pad.right).toBeGreaterThanOrEqual(47.99);
    expect(100 - pad.top - pad.bottom).toBeGreaterThanOrEqual(47.99);
  });

  test("leaves content room across the range of plausible widths", () => {
    for (const width of [320, 480, 680, 1000, 1280, 1920]) {
      for (const expanded of [true, false]) {
        const { left, right } = fitPadding(width, 800, expanded);
        expect(width - left - right).toBeGreaterThanOrEqual(47.99);
      }
    }
  });
});
