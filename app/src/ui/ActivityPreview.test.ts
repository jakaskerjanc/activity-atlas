import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPreview, timeCard } from "./ActivityPreview";
import { record } from "../testFixtures";
import type { DetailFile } from "../types";

const route: [number, number][] = [
  [14.5, 46.05],
  [14.52, 46.07],
  [14.55, 46.06],
];

const render = (over: Partial<Parameters<typeof ActivityPreview>[0]> = {}) =>
  renderToStaticMarkup(createElement(ActivityPreview, { activity: record({ name: "Morning Run" }), ...over }));

describe("ActivityPreview", () => {
  test("sketches the route, shows the map panel's stats and the time, and offers the map", () => {
    const html = render({
      activity: record({ name: "Morning Run", start_local: "2024-08-18T07:42:10", elapsed_time: 3060 }),
      coords: route,
      onShowOnMap: () => {},
    });
    expect(html).toContain('aria-label="Route of Morning Run"');
    for (const label of ["Distance", "Moving time", "Climb", "Pace", "Time"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("07:42–08:33");
    expect(html).toContain("Show on map");
  });

  test("puts the route on a map image in the theme's style, given a token", () => {
    const html = render({ coords: route, token: "pk.test", theme: "dark" });
    expect(html).toMatch(/<img[^>]*src="https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/dark-v11\/static\//);
    // The live light style is Mapbox Standard, which the Static Images API can't draw.
    expect(render({ coords: route, token: "pk.test", theme: "light" })).toContain("/styles/v1/mapbox/light-v11/static/");
    expect(render({ coords: route, token: "" })).not.toContain("<img");
  });

  test("without a route: no sketch and no map button", () => {
    const html = render();
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Show on map");
  });

  test("leaves out stats it doesn't know", () => {
    const html = render({ activity: record({ distance: undefined, moving_time: undefined, elevation_gain: undefined }) });
    expect(html).not.toContain("Pace");
    expect(html).not.toContain("—");
  });

  test("colors the heart-rate line by zone, with average and max in its title", () => {
    const detail: DetailFile = { v: 1, step: 10, t: [0, 10, 20, 30], d: [0, 40, 80, 120], alt: [300, 320, 360, 310], hr: [95, 125, 145, 150] };
    const html = render({
      activity: record({ detail: true, avg_hr: 131, max_hr: 168 }),
      detail: { status: "ready", detail },
      zoneLimits: [100, 120, 140, 160, 180],
    });
    expect(html).not.toContain("Heart-rate zones");
    expect(html).toMatch(/Heart rate.*avg .*>131<.*max .*>168</);
    expect(html).toContain('stroke="var(--zone-line-2)"');
    expect(html).toContain('stroke="var(--zone-line-3)"');
  });

  test("links to the provider pages", () => {
    const html = render({ activity: record({ sources: [{ provider: "strava", id: "42" }] }) });
    expect(html).toContain('href="https://www.strava.com/activities/42"');
    expect(html).toContain("View on Strava");
  });

  test("draws the map panel's charts from the detail samples, the high point in the elevation title", () => {
    const detail: DetailFile = { v: 1, step: 10, t: [0, 10, 20, 30], d: [0, 40, 80, 120], alt: [300, 320, 360, 310], hr: [100, 120, 130, 125] };
    const html = render({ activity: record({ detail: true }), detail: { status: "ready", detail } });
    expect(html).toContain('aria-label="Elevation, m"');
    expect(html).toContain('aria-label="Heart rate, bpm"');
    // No map route to hover here, so no hint offers one.
    expect(html).not.toContain("or the route");
    expect(html).toContain("High point");
    expect(html).toContain(">360<");
  });

  test("says when the samples are loading or failed; without samples, no charts and no line", () => {
    const sampled = record({ detail: true });
    expect(render({ activity: sampled, detail: { status: "loading" } })).toContain("Loading samples…");
    expect(render({ activity: sampled, detail: { status: "error" } })).toContain("load samples.");
    const html = render({ activity: record(), detail: { status: "none" } });
    expect(html).not.toContain("samples");
    expect(html).not.toContain("<svg");
  });
});

describe("timeCard", () => {
  test("the local start to finish, naming the elapsed time when it stopped along the way", () => {
    expect(timeCard(record({ start_local: "2024-08-18T07:42:10", elapsed_time: 3725 }))).toEqual({
      value: "07:42–08:44",
      label: "Time · 1h 2m elapsed",
      wide: true,
    });
    // Under two minutes of stops, the span says it all; past midnight it wraps.
    expect(timeCard(record({ start_local: "2024-08-18T23:30:00", elapsed_time: 3060 }))).toEqual({
      value: "23:30–00:21",
      label: "Time",
      wide: true,
    });
  });

  test("just the start without an elapsed time; nothing without a local start", () => {
    expect(timeCard(record({ start_local: "2024-08-18T07:42:10" }))).toEqual({ value: "07:42", label: "Start time" });
    expect(timeCard(record())).toBeNull();
  });
});
