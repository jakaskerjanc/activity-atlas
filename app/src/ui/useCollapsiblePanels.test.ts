// Which panels auto-collapse, and the derived width at which both fit side by side.

import { describe, expect, test } from "vitest";
import { forcedCollapse } from "./useCollapsiblePanels";
import { BOTH_PANELS_MIN_WIDTH, DETAIL_PANEL_CLEARANCE, MIN_MAP_WIDTH, SIDE_PANEL_CLEARANCE } from "./layout";

describe("forcedCollapse", () => {
  test("a phone closes the filters overlay and leaves the sheet at its peek", () => {
    expect(forcedCollapse(true, false)).toEqual({ side: true, bottom: true });
  });

  test("too narrow for both docked panels hides only the filters", () => {
    expect(forcedCollapse(false, false)).toEqual({ side: true, bottom: false });
  });

  test("wide enough leaves both open", () => {
    expect(forcedCollapse(false, true)).toEqual({ side: false, bottom: false });
  });
});

describe("BOTH_PANELS_MIN_WIDTH", () => {
  test("leaves a usable map column between the two docked panels", () => {
    expect(BOTH_PANELS_MIN_WIDTH).toBe(SIDE_PANEL_CLEARANCE + DETAIL_PANEL_CLEARANCE + MIN_MAP_WIDTH);
    expect(BOTH_PANELS_MIN_WIDTH).toBeLessThanOrEqual(1280);
  });
});
