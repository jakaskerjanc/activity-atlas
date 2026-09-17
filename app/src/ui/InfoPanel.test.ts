// The bottom panel stays centered regardless of the side panel: the old avoidLeft shift
// (which made it jump when the side panel collapsed) is gone.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InfoPanel } from "./InfoPanel";

const props = {
  title: "All Activities",
  subtitle: "Jan — Dec",
  cards: [{ value: "1", label: "Activities" }],
  link: null,
  collapsed: false,
  onToggle: () => {},
};

describe("InfoPanel anchoring", () => {
  test("centers itself instead of shifting around an open side panel", () => {
    const html = renderToStaticMarkup(createElement(InfoPanel, props));
    expect(html).toContain("translateX(-50%)");
    expect(html).not.toContain("max(");
  });

  test("leaves its title strip peeking, clickable, when collapsed", () => {
    const html = renderToStaticMarkup(
      createElement(InfoPanel, { ...props, collapsed: true }),
    );
    expect(html).toContain("translateX(-50%) translateY(calc(100% - 48px))");
    expect(html).toContain('aria-label="Expand details"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("cursor:pointer");
  });
});
