import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitiesView } from "./ActivitiesView";
import { createActivityFilter } from "../activityFilter";
import { DEFAULT_SORT } from "../activitySearch";
import { record } from "../testFixtures";

const run = record({ id: "a", name: "Morning Run", type: "Run" });
const swim = record({ id: "b", name: "Pool swim", type: "Swim" });
const filter = createActivityFilter([run, swim]); // Swim is off by default

const render = (over: { query?: string; routed?: string[]; mobile?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(ActivitiesView, {
      filter,
      visible: [run],
      names: { places: new Map(), routes: new Map() },
      routes: new Map((over.routed ?? ["a"]).map((id) => [id, [[14, 46], [14.1, 46.1]] as [number, number][]])),
      query: over.query ?? "",
      onQueryChange: () => {},
      sort: DEFAULT_SORT,
      onSortChange: () => {},
      onOpen: () => {},
      onReveal: () => {},
      sidePanelExpanded: true,
      mobile: over.mobile,
    }),
  );

describe("ActivitiesView", () => {
  test("lists the visible activities with a search box and sortable columns", () => {
    const html = render();
    expect(html).toContain('aria-label="Search activities"');
    expect(html).toContain("Morning Run");
    expect(html).not.toContain("Pool swim");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Date/);
  });

  test("every row is a closed preview toggle; one without a route says so", () => {
    expect(render()).toMatch(/<button[^>]*data-row="a"[^>]*aria-expanded="false"/);
    const html = render({ routed: [] });
    expect(html).toMatch(/<button[^>]*data-row="a"/);
    expect(html).toContain("No route");
  });

  test("marks the query in the names", () => {
    expect(render({ query: "morn" })).toContain("<mark");
  });

  test("says when nothing visible matches, and offers the matches the filter hides", () => {
    const html = render({ query: "swim" });
    expect(html).toContain("No visible activity matches “swim”.");
    expect(html).toContain("1 more activity outside the filter matches.");
    expect(html).toContain("Show it");
  });

  test("on a phone, sorts from a menu instead of column headers", () => {
    const html = render({ mobile: true });
    expect(html).toContain('aria-label="Sort activities"');
    expect(html).not.toContain('aria-label="Sort by"');
  });
});
