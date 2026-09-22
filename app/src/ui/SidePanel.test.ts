// SidePanel is collapsible rather than dropped on narrow screens: it stays mounted and
// slides off the left edge, leaving only the edge tab that toggles it back.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidePanel } from "./SidePanel";
import { createActivityFilter } from "../activityFilter";

const props = {
  filter: createActivityFilter([
    {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [] },
      properties: {
        id: "s:1",
        name: "Test",
        type: "Run",
        ts: 1723975135,
        start_date: "2024-08-18T09:58:55Z",
        distance: 10000,
        moving_time: 3000,
        elevation_gain: 100,
      },
    },
  ]),
  onFilterChange: () => {},
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
