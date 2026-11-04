import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsView } from "./AnalyticsView";
import { createActivityFilter, toggleType, visibleActivities } from "../activityFilter";
import { record } from "../testFixtures";

const filter = createActivityFilter([record({ type: "Run" })]);

const render = (props: Partial<Parameters<typeof AnalyticsView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AnalyticsView, {
      filter,
      visible: visibleActivities(filter),
      sidePanelExpanded: true,
      ...props,
    }),
  );

describe("AnalyticsView", () => {
  test("shows the consistency card and activity calendar for the visible activities", () => {
    const html = render();
    expect(html).toContain("Consistency");
    expect(html).toContain("Active days");
    expect(html).toContain("Activity calendar");
    expect(html).toContain("August 2024 — August 2024");
  });

  test("explains an empty filter instead of showing zeros", () => {
    const empty = toggleType(filter, "Run");
    const html = render({ filter: empty, visible: visibleActivities(empty) });
    expect(html).toContain("No activities match the filter");
    expect(html).not.toContain("Consistency");
    expect(html).not.toContain("Activity calendar");
  });

  test("renders just the page heading until the data loads", () => {
    const html = render({ filter: null, visible: [] });
    expect(html).toContain("Analytics");
    expect(html).not.toContain("Consistency");
  });

  test("centers a calendar-wide column, kept clear of the side panel's edge tab", () => {
    expect(render()).toContain(
      "grid-template-columns:minmax(402px, 1fr) minmax(0, 751px) minmax(24px, 1fr)",
    );
    expect(render({ sidePanelExpanded: false })).toContain("minmax(70px, 1fr)");
  });
});
