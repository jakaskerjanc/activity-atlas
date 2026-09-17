// Which panels auto-collapse, and the derived width at which both fit side by side.

import { describe, expect, test } from "vitest";
import { forcedCollapse } from "./useCollapsiblePanels";
import { BOTH_PANELS_MIN_WIDTH } from "./layout";

describe("forcedCollapse", () => {
  test("narrow collapses both panels", () => {
    expect(forcedCollapse(true, false)).toEqual({ side: true, bottom: true });
  });

  test("too narrow for both collapses only the side panel", () => {
    expect(forcedCollapse(false, false)).toEqual({ side: true, bottom: false });
  });

  test("wide enough leaves both open", () => {
    expect(forcedCollapse(false, true)).toEqual({ side: false, bottom: false });
  });
});

describe("BOTH_PANELS_MIN_WIDTH", () => {
  test("is the smallest width where the centered bottom panel clears the side panel", () => {
    expect(BOTH_PANELS_MIN_WIDTH).toBe(1216);
  });
});
