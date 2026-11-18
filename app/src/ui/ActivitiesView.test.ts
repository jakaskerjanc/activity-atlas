import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitiesView } from "./ActivitiesView";
import { createActivityFilter } from "../activityFilter";
import { DEFAULT_SORT } from "../activitySearch";
import { record } from "../testFixtures";
import type { ActivityRecord } from "../types";

const run = record({ id: "a", name: "Morning Run", type: "Run" });
const swim = record({ id: "b", name: "Pool swim", type: "Swim" });
const filter = createActivityFilter([run, swim]); // Swim is off by default

const render = (
  over: { query?: string; routed?: string[] | null; mobile?: boolean; visible?: ActivityRecord[] } = {},
) =>
  renderToStaticMarkup(
    createElement(ActivitiesView, {
      filter,
      visible: over.visible ?? [run],
      names: { places: new Map(), routes: new Map() },
      routes:
        over.routed === null
          ? null
          : new Map((over.routed ?? ["a"]).map((id) => [id, [[14, 46], [14.1, 46.1]] as [number, number][]])),
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

  test("while the routes load, a row with GPS doesn't claim to have no route", () => {
    const html = render({ routed: null, visible: [record({ id: "a", type: "Run", channels: ["gps"] })] });
    expect(html).toMatch(/<button[^>]*data-row="a"/);
    expect(html).not.toContain("No route");
  });

  test("while the routes load, a row without GPS already says so", () => {
    expect(render({ routed: null, visible: [record({ id: "a", type: "Run", channels: [] })] })).toContain("No route");
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

  test("draws only the first rows of a long list, and says how long it is", () => {
    const many = Array.from({ length: 500 }, (_, i) => record({ id: `r${i}`, name: `Run ${i}`, type: "Run", ts: 1_700_000_000 - i * 86_400 }));
    const html = render({ visible: many, routed: [] });
    const drawn = html.match(/data-row="/g)?.length ?? 0;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(60);
    expect(html).toContain('aria-setsize="500"');
    expect(html).toContain('aria-posinset="1"');
  });

  test("on a phone, sorts from a menu instead of column headers", () => {
    const html = render({ mobile: true });
    expect(html).toContain('aria-label="Sort activities"');
    expect(html).not.toContain('aria-label="Sort by"');
  });
});
