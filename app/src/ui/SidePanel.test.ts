// SidePanel is collapsible rather than dropped on narrow screens: it stays mounted and
// slides off the left edge, leaving only the edge tab that toggles it back.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidePanel } from "./SidePanel";

const props = {
  availableTypes: ["Run"],
  typeCounts: { Run: 1 },
  enabledTypes: new Set(["Run"]),
  onToggleType: () => {},
  minMonth: 0,
  maxMonth: 1,
  fromMonth: 0,
  toMonth: 1,
  onFromChange: () => {},
  onToChange: () => {},
  colorMode: "recency" as const,
  colorDomain: {
    tsMin: 0,
    tsMax: 1,
    elevMin: 0,
    elevMax: 1,
    speedMin: 0,
    speedMax: 1,
    types: ["Run"],
  },
  onColorModeChange: () => {},
  onStartReplay: () => {},
  canReplay: true,
  collapsed: false,
  onToggle: () => {},
};

describe("SidePanel collapse", () => {
  test("renders an in-place toggle tab when expanded", () => {
    const html = renderToStaticMarkup(createElement(SidePanel, props));
    expect(html).toContain('aria-label="Collapse filters"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("translateX(-100%)");
  });

  test("slides off-screen and offers to expand when collapsed", () => {
    const html = renderToStaticMarkup(
      createElement(SidePanel, { ...props, collapsed: true }),
    );
    expect(html).toContain('aria-label="Expand filters"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("translateX(-100%)");
  });

  test("keeps rendering below the old 680px breakpoint, since collapse replaced it", () => {
    const html = renderToStaticMarkup(
      createElement(SidePanel, { ...props, collapsed: true }),
    );
    expect(html).not.toBe("");
  });
});
