// Issue #23 §5: "Totals reconcile with map totals". One fixture, read as the display
// files, goes through the map's path (joinActivities → map features; InfoPanel with the
// aggregate cards App builds) and the analytics page's path (AnalyticsView). Both must
// show the same four totals, with the same rules for unknown values.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import polyline from "@mapbox/polyline";
import { ACTIVITIES_VERSION, joinActivities, ROUTES_VERSION } from "./tracks";
import {
  createActivityFilter,
  toggleType,
  visibleActivities,
  visibleFeatures,
  type ActivityFilter,
} from "./activityFilter";
import { totalCards } from "./stats";
import { InfoPanel } from "./ui/InfoPanel";
import { AnalyticsView } from "./ui/AnalyticsView";
import { record } from "./testFixtures";
import type { ActivitiesFile, RoutesFile } from "./types";

const at = (iso: string) => Date.parse(iso) / 1000;
const route = polyline.encode([
  [46.05017, 14.48691],
  [46.05243, 14.4906],
]);

// Unknown values are absent, as activities.json writes them.
const activities: ActivitiesFile = {
  v: ACTIVITIES_VERSION,
  activities: [
    record({ id: "run", type: "Run", ts: at("2024-08-01T07:00:00Z"), distance: 10000, elevation_gain: 120, moving_time: 3000 }),
    // A hike whose watch had no altimeter: no elevation.
    record({ id: "hike", type: "Hike", ts: at("2024-08-03T08:00:00Z"), distance: 15500, elevation_gain: undefined, moving_time: 18000 }),
    // A gym session: no route, no distance, no elevation. Not on the map, still counted.
    record({ id: "gym", type: "WeightTraining", ts: at("2024-08-05T17:00:00Z"), distance: undefined, elevation_gain: undefined, moving_time: 2700 }),
  ],
};
const routes: RoutesFile = { v: ROUTES_VERSION, routes: { run: route, hike: route } };

const LABELS = ["Activities", "Distance", "Elevation gain", "Moving time"];

/** The value shown above each total card's label, in LABELS order. */
function totalsIn(html: string): string[] {
  return LABELS.map((label) => {
    // The value div right before the label: a value and an optional small unit, or a
    // duration in parts with its whole text for screen readers.
    const m = html.match(
      new RegExp(`<div style="[^"]*">((?:(?!</div>|<div).)*)</div><div style="[^"]*">${label}</div>`),
    );
    expect(m, `${label} card`).not.toBeNull();
    const whole = m![1].match(/class="sr-only">([^<]*)</);
    return whole ? whole[1] : m![1].replace(/<span.*$/, "");
  });
}

/** The map's aggregate panel, built the way App builds it when nothing is selected. */
function mapTotals(filter: ActivityFilter): string[] {
  const html = renderToStaticMarkup(
    createElement(InfoPanel, {
      title: "All Activities",
      subtitle: "",
      cards: totalCards(visibleActivities(filter)),
      links: [],
      collapsed: false,
      onToggle: () => {},
    }),
  );
  return totalsIn(html);
}

function analyticsTotals(filter: ActivityFilter): string[] {
  const html = renderToStaticMarkup(
    createElement(AnalyticsView, {
      filter,
      visible: visibleActivities(filter),
      sidePanelExpanded: true,
      isolation: null,
      onPickMonth: () => {},
      cities: { status: "loading" },
      comparisons: [],
      onShowCity: () => {},
    }),
  );
  expect(html).toContain("Totals");
  return totalsIn(html);
}

describe("analytics totals reconcile with the map's totals", () => {
  const features = joinActivities(routes, activities).features;
  // Every type on, the gym session included (it is off by default).
  const filter = toggleType(createActivityFilter(activities.activities), "WeightTraining");

  test("the map draws only the routed activities, but both pages total all of them", () => {
    expect(visibleFeatures(filter, features).map((f) => f.properties.id)).toEqual(["run", "hike"]);
    // 3 activities; 25.5 km from the two with a distance; 120 m from the one with an
    // elevation; 6h 35m of moving time. Unknowns are skipped, not counted as 0.
    const expected = ["3", "26", "120", "6h 35m"];
    expect(mapTotals(filter)).toEqual(expected);
    expect(analyticsTotals(filter)).toEqual(expected);
  });

  test("they stay equal under the shared filter", () => {
    for (const f of [toggleType(filter, "Run"), toggleType(filter, "WeightTraining")]) {
      expect(analyticsTotals(f)).toEqual(mapTotals(f));
    }
  });

  test("a total with no known value is a dash on both pages", () => {
    const gymOnly = toggleType(toggleType(filter, "Run"), "Hike");
    expect(mapTotals(gymOnly)).toEqual(["1", "—", "—", "45m"]);
    expect(analyticsTotals(gymOnly)).toEqual(mapTotals(gymOnly));
  });
});
