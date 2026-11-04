import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsView } from "./AnalyticsView";
import { createActivityFilter, toggleType, visibleActivities } from "../activityFilter";
import { record } from "../testFixtures";

const filter = createActivityFilter([record({ type: "Run" })]);

type Props = Parameters<typeof AnalyticsView>[0];

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(AnalyticsView, {
      filter,
      visible: visibleActivities(filter),
      sidePanelExpanded: true,
      theme: "dark",
      isolation: null,
      onPickMonth: () => {},
      ...props,
    } as Props),
  );

describe("AnalyticsView", () => {
  test("shows the consistency card and activity calendar for the visible activities", () => {
    const html = render();
    expect(html).toContain("Consistency");
    expect(html).toContain("Active days");
    expect(html).toContain("Activity calendar");
    expect(html).toContain("August 2024 — August 2024");
  });

  test("shows the climbing ridgeline from the activities alone", () => {
    const html = render();
    expect(html).toContain("Climbing by month");
    expect(html).toContain(
      'aria-label="August 2024 · 1 activity · 100 m gain · biggest day Aug 18, 2024: 100 m"',
    );
    expect(html).toContain("click a month to show only it");
  });

  test("shows the elevation heatmap once the route profiles load", () => {
    expect(render()).toContain("Loading elevation profiles");
    const ready = (profiles: Record<string, number[]>) =>
      render({ profiles: { status: "ready", file: { v: 1, step: 100, profiles } } });
    expect(ready({ "s:1": [0, 30, 10] })).toContain("1 activity, each measured from its start");
    expect(ready({})).toContain("No visible activity has an elevation profile.");
    expect(render({ profiles: { status: "error" } })).toContain("Couldn&#x27;t load elevation profiles");
  });

  test("names the range a second click restores while a month is isolated", () => {
    const month = 2024 * 12 + 7;
    const html = render({
      isolation: { month, fromMonth: month - 5, toMonth: month },
    });
    expect(html).toContain("Click August 2024 again for March 2024 — August 2024");
    expect(html).toContain('aria-pressed="true"');
  });

  test("explains an empty filter instead of showing zeros", () => {
    const empty = toggleType(filter, "Run");
    const html = render({ filter: empty, visible: visibleActivities(empty) });
    expect(html).toContain("No activities match the filter");
    expect(html).not.toContain("Consistency");
    expect(html).not.toContain("Activity calendar");
    expect(html).not.toContain("Climbing by month");
    expect(html).not.toContain("Elevation profiles");
  });

  test("renders just the page heading until the data loads", () => {
    const html = render({ filter: null, visible: [] });
    expect(html).toContain("Analytics");
    expect(html).not.toContain("Consistency");
  });

  test("centers a calendar-wide column, kept clear of the side panel's edge tab", () => {
    expect(render()).toContain(
      "grid-template-columns:minmax(402px, 1fr) minmax(0, 753px) minmax(24px, 1fr)",
    );
    expect(render({ sidePanelExpanded: false })).toContain("minmax(70px, 1fr)");
  });
});
