// The detail panel docks top-right on desktop and is a bottom sheet on a phone; either
// way, collapsing keeps its title strip and drops the body.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InfoPanel } from "./InfoPanel";
import { DETAIL_PANEL_WIDTH } from "./layout";

const props = {
  title: "All activities",
  subtitle: "Jan – Dec",
  cards: [{ value: "1", label: "Activities" }],
  links: [],
  collapsed: false,
  onToggle: () => {},
};

const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(InfoPanel, { ...props, ...over }));

describe("InfoPanel placement", () => {
  test("docks top-right on desktop, out of the map's middle", () => {
    const html = render();
    expect(html).toContain(`right:20px`);
    expect(html).toContain(`width:${DETAIL_PANEL_WIDTH}px`);
  });

  test("is a full-width bottom sheet with a grab handle on a phone", () => {
    const html = render({ mobile: true });
    expect(html).toContain("panel--sheet");
    expect(html).toContain("sheet-handle");
  });

  test("scrolls instead of outgrowing the viewport", () => {
    expect(render()).toContain("max-height:calc(100% - 94px)");
  });
});

describe("InfoPanel collapse", () => {
  test("keeps the title strip and drops the body when collapsed", () => {
    const html = render({ collapsed: true });
    expect(html).toContain("All activities");
    expect(html).not.toContain(">Activities<");
    expect(html).toContain('aria-label="Expand details"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("offers to collapse when open", () => {
    const html = render();
    expect(html).toContain('aria-label="Collapse details"');
    expect(html).toContain('aria-expanded="true"');
  });
});

describe("InfoPanel body", () => {
  test("renders the body under the cards", () => {
    const html = render({ body: createElement("p", null, "charts here") });
    expect(html.indexOf("charts here")).toBeGreaterThan(html.indexOf("Activities"));
  });

  test("cards sit in a 2x2 grid", () => {
    expect(render()).toContain("repeat(2, 1fr)");
  });

  test("a notice replaces the cards (nothing matches the filter)", () => {
    const html = render({ notice: createElement("p", null, "No activities match") });
    expect(html).toContain("No activities match");
    expect(html).not.toContain(">Activities<");
  });

  test("the activity's pages show as G and S badges next to each other", () => {
    const html = render({
      links: [
        { url: "https://connect.garmin.com/modern/activity/2", label: "View on Garmin Connect", short: "G" },
        { url: "https://www.strava.com/activities/1", label: "View on Strava", short: "S" },
      ],
    });
    expect(html).toMatch(/href="https:\/\/connect\.garmin\.com[^"]*"[^>]*aria-label="View on Garmin Connect"[^>]*>G<\/a><a[^>]*href="https:\/\/www\.strava\.com\/activities\/1"[^>]*>S<\/a>/);
    expect(html).not.toContain("View on Strava</a>");
  });
});
