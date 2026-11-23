import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitiesView } from "./ActivitiesView";
import { createActivityFilter } from "../activityFilter";
import { DEFAULT_SORT, type Sort } from "../activitySearch";
import type { Grouping } from "../activityGroups";
import { record } from "../testFixtures";
import type { ActivityRecord } from "../types";

const run = record({ id: "a", name: "Morning Run", type: "Run" });
const swim = record({ id: "b", name: "Pool swim", type: "Swim" });
const filter = createActivityFilter([run, swim]); // Swim is off by default

const render = (
  over: {
    query?: string;
    routed?: string[] | null;
    mobile?: boolean;
    visible?: ActivityRecord[];
    grouping?: Grouping;
    sort?: Sort;
  } = {},
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
      sort: over.sort ?? DEFAULT_SORT,
      onSortChange: () => {},
      grouping: over.grouping ?? "none",
      onGroupingChange: () => {},
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

  test("a row draws its route small beside the name; one without keeps the empty slot", () => {
    expect(render()).toMatch(/<svg[^>]*class="activities__thumb"[^>]*><path d="M/);
    expect(render({ routed: [] })).toMatch(/<svg[^>]*class="activities__thumb"[^>]*><\/svg>/);
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

  test("offers the Group choice: pills on a wide screen, a menu on a phone", () => {
    const html = render();
    expect(html).toMatch(/role="group" aria-label="Group activities"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>None</);
    expect(render({ mobile: true })).toMatch(/<select aria-label="Group activities"/);
  });

  test("grouped by month: a header with the subtotals over its rows, a line for the empty months", () => {
    const visible = [
      record({ id: "n", name: "November run", type: "Run", ts: Date.parse("2026-11-21T08:00:00Z") / 1000, distance: 11_200 }),
      record({ id: "j", name: "June run", type: "Run", ts: Date.parse("2026-06-10T08:00:00Z") / 1000, distance: 8_000 }),
    ];
    const html = render({ visible, grouping: "month", routed: [] });
    expect(html).toContain("November 2026");
    expect(html).toContain("1 activity · 11 km · 50m · 100 m");
    expect(html).toContain("4 months without activities");
    // The headers aren't counted as activities.
    expect(html).toContain('aria-setsize="2"');
    expect(html).toMatch(/aria-posinset="2"[^>]*>.*June run/);
    expect(html.indexOf("November 2026")).toBeLessThan(html.indexOf("November run"));
    expect(html.indexOf("November run")).toBeLessThan(html.indexOf("June 2026"));
  });

  test("grouped while searching, the empty stretch is one without matches", () => {
    const visible = [
      record({ id: "n", name: "Hill run", type: "Run", ts: Date.parse("2026-11-21T08:00:00Z") / 1000 }),
      record({ id: "j", name: "Hill run", type: "Run", ts: Date.parse("2026-10-01T08:00:00Z") / 1000 }),
      record({ id: "x", name: "Flat run", type: "Run", ts: Date.parse("2026-10-20T08:00:00Z") / 1000 }),
    ];
    const f = createActivityFilter(visible);
    const html = renderToStaticMarkup(
      createElement(ActivitiesView, {
        filter: f,
        visible,
        names: { places: new Map(), routes: new Map() },
        routes: new Map(),
        query: "hill",
        onQueryChange: () => {},
        sort: DEFAULT_SORT,
        onSortChange: () => {},
        grouping: "week",
        onGroupingChange: () => {},
        onOpen: () => {},
        onReveal: () => {},
        sidePanelExpanded: true,
      }),
    );
    expect(html).not.toContain("Flat run");
    expect(html).toMatch(/\d+ weeks without matches/);
  });
});
