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
  links: [],
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

describe("InfoPanel body", () => {
  test("renders the body under the cards", () => {
    const html = renderToStaticMarkup(
      createElement(InfoPanel, { ...props, body: createElement("p", null, "charts here") }),
    );
    expect(html.indexOf("charts here")).toBeGreaterThan(html.indexOf("Activities"));
  });

  test("compact cards use four columns", () => {
    const html = renderToStaticMarkup(createElement(InfoPanel, { ...props, compactCards: true }));
    expect(html).toContain("repeat(4, 1fr)");
    const wide = renderToStaticMarkup(createElement(InfoPanel, props));
    expect(wide).toContain("1fr 1fr");
  });

  test("scrolls instead of outgrowing the viewport", () => {
    expect(renderToStaticMarkup(createElement(InfoPanel, props))).toContain("calc(100vh - 140px)");
  });
});
