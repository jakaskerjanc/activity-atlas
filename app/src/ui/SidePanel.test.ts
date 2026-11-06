// SidePanel is collapsible rather than dropped on narrow screens: it stays mounted and
// slides fully off-screen (no clipped sliver), leaving the header's Filters button.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidePanel, shownLine } from "./SidePanel";
import { createActivityFilter } from "../activityFilter";
import { record } from "../testFixtures";
import { typeColor } from "../colors";

const props = {
  filter: createActivityFilter([record()]),
  onFilterChange: () => {},
  shownCount: 1,
  colorMode: "recency" as const,
  colorDomain: {
    tsMin: 0,
    tsMax: 1,
    speedMin: 0,
    speedMax: 1,
    types: ["Run"],
  },
  onColorModeChange: () => {},
  theme: "dark" as const,
  onStartReplay: () => {},
  canReplay: true,
  showMapControls: true,
  collapsed: false,
  onToggle: () => {},
};

const render = (over: Partial<typeof props> & { mobile?: boolean } = {}) =>
  renderToStaticMarkup(createElement(SidePanel, { ...props, ...over }));

describe("SidePanel on the analytics page", () => {
  test("keeps the filter but drops map coloring and replay", () => {
    const html = render({ showMapControls: false });
    expect(html).toContain("Activity types");
    expect(html).not.toContain("Route color");
    expect(html).not.toContain("Replay history");
  });
});

describe("SidePanel collapse", () => {
  test("has its own hide control, aligned with its title", () => {
    const html = render();
    expect(html).toContain('aria-label="Hide filters"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('data-hidden="true"');
  });

  test("slides fully off-screen and leaves the tab order when collapsed", () => {
    const html = render({ collapsed: true });
    expect(html).toContain('data-hidden="true"');
    expect(html).toContain("inert");
    expect(html).toContain('aria-expanded="false"');
  });

  test("on a phone it closes instead of hiding", () => {
    expect(render({ mobile: true })).toContain('aria-label="Close filters"');
  });

  test("says how many activities pass the filter, and how many it hides", () => {
    expect(render()).toContain("All 1 activities shown");
    expect(shownLine(446, 531)).toBe("446 shown, 85 filtered out");
  });

  test("lists the analytics sections as jump links", () => {
    const html = render({ showMapControls: false, sections: [{ id: "totals", label: "Totals" }] } as never);
    expect(html).toContain("On this page");
    expect(html).toContain(">Totals</a>");
  });
});

describe("SidePanel type list", () => {
  test("is the map's legend in Type mode: each swatch takes its type's color", () => {
    // Five runs, so Run is common enough to be listed; outside Type mode its swatch is
    // the plain accent.
    const runs = createActivityFilter(Array.from({ length: 5 }, (_, i) => record({ id: `r${i}` })));
    expect(render({ filter: runs, colorMode: "type" as never })).toContain(`background:${typeColor("Run")}`);
    expect(render({ filter: runs })).toContain("background:var(--accent)");
  });

  test("toggles say whether they are on", () => {
    const runs = createActivityFilter(Array.from({ length: 5 }, (_, i) => record({ id: `r${i}` })));
    expect(render({ filter: runs })).toMatch(/aria-pressed="true"[^>]*>.*Run/);
  });
});
