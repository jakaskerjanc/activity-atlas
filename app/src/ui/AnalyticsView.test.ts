import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsView } from "./AnalyticsView";
import { createActivityFilter, togglePlace, toggleType, visibleActivities } from "../activityFilter";
import { record } from "../testFixtures";
import { cityComparisons } from "../cityMatch";
import type { CityData } from "../cities";
import { SIDE_PANEL_CLEARANCE } from "./layout";
import type { Place } from "../types";

const filter = createActivityFilter([record({ type: "Run" })]);

type Props = Parameters<typeof AnalyticsView>[0];

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(AnalyticsView, {
      filter,
      visible: visibleActivities(filter),
      sidePanelExpanded: true,
      isolation: null,
      onPickMonth: () => {},
      cities: { status: "loading" },
      comparisons: [],
      onShowCity: () => {},
      ...props,
    } as Props),
  );

describe("AnalyticsView", () => {
  test("shows the consistency card and activity calendar for the visible activities", () => {
    const html = render();
    expect(html).toContain("Consistency");
    expect(html).toContain("Active days");
    expect(html).toContain("Activity calendar");
    expect(html).toContain("1 activity from Aug 2024 to Aug 2024");
  });

  test("shows the climbing ridgeline from the activities alone", () => {
    const html = render();
    expect(html).toContain("Climbing by month");
    expect(html).toContain(
      'aria-label="August 2024 · 1 activity · 100 m gain · biggest day Aug 18, 2024: 100 m"',
    );
    expect(html).toContain("Select a month to show only it.");
  });

  test("shows the heart-rate zones with their bpm ranges, leaving out activities without zones", () => {
    const zoned = createActivityFilter([
      record({ id: "a", hr_zones: [600, 1200, 1800, 0, 0, 0] }),
      record({ id: "b" }),
    ]);
    const html = render({ filter: zoned, visible: visibleActivities(zoned), zoneLimits: [100, 119, 139, 159, 179] });
    expect(html).toContain("Heart-rate zones");
    expect(html).toContain("Zone 1 starts at 100 bpm, zone 5 at 179 bpm");
    expect(html).toContain("119–139 bpm");
    expect(html).toContain("30 min · 50%");
    expect(html).toContain(">1.0 h<");
    expect(html).toContain(">with heart rate<");
    expect(html).not.toContain("have heart-rate zones");
  });

  test("says so when no visible activity has heart-rate zones", () => {
    expect(render()).toContain("No visible activity has heart-rate zones.");
    const zoned = createActivityFilter([record({ hr_zones: [0, 60, 0, 0, 0, 0] })]);
    // Zones without reference limits (shouldn't happen) aren't drawn either.
    expect(render({ filter: zoned, visible: visibleActivities(zoned) })).toContain(
      "No visible activity has heart-rate zones.",
    );
  });

  test("shows the elevation profiles once the route profiles load", () => {
    expect(render()).toContain("Loading elevation profiles");
    const ready = (profiles: Record<string, number[]>) =>
      render({ profiles: { status: "ready", file: { v: 1, step: 100, profiles } } });
    expect(ready({ "s:1": [0, 30, 10] })).toContain(
      'aria-label="Elevation of 1 activity against distance, overlaid"',
    );
    expect(ready({})).toContain("No visible activity has an elevation profile.");
    expect(render({ profiles: { status: "error" } })).toContain("Couldn&#x27;t load elevation profiles");
  });

  test("compares the distance with a trip from the origin, once the cities load", () => {
    expect(render()).toContain("Loading cities…");
    expect(render({ cities: { status: "error" } })).toContain(
      "Couldn&#x27;t load the city distances.",
    );

    const route = (km: number) => ({ m: km * 1000, coords: [[14.5, 46], [15, 45]] as [number, number][] });
    const data: CityData = {
      origin: { name: "Ljubljana", lat: 46.0569, lon: 14.5058 },
      cities: [
        { id: 1, name: "Kranj", country: "SI", fc: "PPL", lat: 46.24, lon: 14.36, population: 37000, cycling: route(26), walking: route(27) },
        { id: 2, name: "Zagreb", country: "HR", fc: "PPLC", lat: 45.81, lon: 15.98, population: 700000, cycling: route(153), walking: null },
      ],
    };
    const html = render({
      cities: { status: "ready", data },
      // The fixture's 10 km run is short of the nearest city.
      comparisons: cityComparisons(visibleActivities(filter), data.cities),
    });
    expect(html).toContain("Your distance as one trip from Ljubljana");
    expect(html).toContain("On foot · 10 km");
    expect(html).toContain("Not yet");
    expect(html).toContain("27 km on foot · Slovenia · 37% of the way");
    expect(html).toContain('aria-label="Show on map: Ljubljana to Kranj on foot"');
    expect(html).not.toContain("Rides");

    expect(render({ cities: { status: "ready", data }, comparisons: [] })).toContain(
      "No visible ride, run, walk or hike has a distance.",
    );
  });

  test("names the range a second click restores while a month is isolated", () => {
    const month = 2024 * 12 + 7;
    const html = render({
      isolation: { month, fromMonth: month - 5, toMonth: month },
    });
    expect(html).toContain("Showing August 2024 only. Click it again for March 2024 – August 2024.");
    expect(html).toContain('aria-pressed="true"');
  });

  test("explains an empty filter instead of showing zeros", () => {
    const empty = toggleType(filter, "Run");
    const html = render({ filter: empty, visible: visibleActivities(empty) });
    expect(html).toContain("No activities match the filter");
    expect(html).not.toContain("Consistency");
    expect(html).not.toContain("Activity calendar");
    expect(html).not.toContain("Climbing by month");
    expect(html).not.toContain("How far is that?");
    expect(html).not.toContain("Elevation profiles");
  });

  test("renders just the page heading until the data loads", () => {
    const html = render({ filter: null, visible: [] });
    expect(html).toContain("Analytics");
    expect(html).not.toContain("Consistency");
  });

  test("starts the column right of the docked filters panel, and uses the page when it's hidden", () => {
    expect(render()).toContain(`--analytics-left:${SIDE_PANEL_CLEARANCE + 24}px`);
    expect(render({ sidePanelExpanded: false })).toContain("--analytics-left:24px");
    // On a phone the filters overlay the page instead of pushing it.
    expect(render({ mobile: true })).toContain("--analytics-left:24px");
  });

  test("offers to reset an empty filter", () => {
    const empty = toggleType(filter, "Run");
    const html = render({ filter: empty, visible: visibleActivities(empty), onResetFilter: () => {} });
    expect(html).toContain("Reset filters");
  });

  test("an empty filter without a place offers only resetting", () => {
    const empty = toggleType(filter, "Run");
    const html = render({ filter: empty, visible: visibleActivities(empty), onResetFilter: () => {}, onClearPlace: () => {} });
    expect(html).toContain("Switch on an activity type or widen the date range.");
    expect(html).not.toContain("Clear place");
  });

  test("an empty filter with a place names it and offers clearing it before resetting", () => {
    const slavnik: Place = { id: "p1", name: "Slavnik", ele: 1028, kind: "peak" };
    const atSlavnik = togglePlace(createActivityFilter([record({ type: "Run", place: "p1" })]), "p1");
    const empty = toggleType(atSlavnik, "Run");
    const html = render({
      filter: empty,
      visible: visibleActivities(empty),
      places: new Map([[slavnik.id, slavnik]]),
      onResetFilter: () => {},
      onClearPlace: () => {},
    });
    expect(html).toContain(
      "No activities to Slavnik match these filters. Switch on an activity type, widen the date range, or clear the place.",
    );
    expect(html).toContain("Clear place");
    expect(html.indexOf("Clear place")).toBeLessThan(html.indexOf("Reset filters"));
  });

  test("adds steps to the calendar only when there is step data", () => {
    expect(render()).toContain("Moving time per day");
    expect(render({ steps: { status: "error" } })).not.toContain(">Steps<");
    expect(render({ steps: { status: "ready", file: { v: 1, steps: [] } } })).not.toContain(">Steps<");
    const html = render({ steps: { status: "ready", file: { v: 1, start: "2024-08-18", steps: [12000] } } });
    expect(html).toContain("Moving time and steps per day");
    expect(html).toContain(">Steps<");
  });

  test("shows the active hours clock", () => {
    const html = render();
    expect(html).toContain("Active hours");
    expect(html).toContain("Weekdays");
    expect(html).toContain("Weekends");
  });
});
