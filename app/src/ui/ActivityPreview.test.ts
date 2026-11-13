import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPreview, previewFacts } from "./ActivityPreview";
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
  test("sketches the route, shows the stats, and offers the map", () => {
    const html = render({ coords: route, onShowOnMap: () => {} });
    expect(html).toContain('aria-label="Route of Morning Run"');
    expect(html).toContain("Distance");
    expect(html).toContain("Pace");
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
    expect(html).not.toContain("Distance");
    expect(html).not.toContain("—");
  });

  test("links to the provider pages", () => {
    const html = render({ activity: record({ sources: [{ provider: "strava", id: "42" }] }) });
    expect(html).toContain('href="https://www.strava.com/activities/42"');
    expect(html).toContain("View on Strava");
  });

  test("draws the map panel's elevation chart, alone, from the detail samples", () => {
    const detail: DetailFile = { v: 1, step: 10, t: [0, 10, 20, 30], d: [0, 40, 80, 120], alt: [300, 320, 360, 310], hr: [100, 120, 130, 125] };
    const html = render({ activity: record({ detail: true }), detail: { status: "ready", detail } });
    expect(html).toContain('aria-label="Elevation, m"');
    expect(html).not.toContain('aria-label="Heart rate, bpm"');
    // No map route to hover here, so the hint never offers one.
    expect(html).not.toContain("or the route");
    expect(html).toContain("m high");
  });

  test("no chart without elevation samples; says when they are loading", () => {
    const detail: DetailFile = { v: 1, step: 10, t: [0, 10], hr: [100, 120] };
    expect(render({ activity: record({ detail: true }), detail: { status: "ready", detail } })).not.toContain('aria-label="Elevation, m"');
    expect(render({ activity: record({ detail: true }), detail: { status: "loading" } })).toContain("Loading samples…");
  });
});

describe("previewFacts", () => {
  test("lists only what is known", () => {
    expect(previewFacts(record())).toEqual([]);
    expect(
      previewFacts(record({ start_local: "2024-08-18T07:42:10", elapsed_time: 3725, avg_hr: 141.4, max_hr: 172 })),
    ).toEqual([
      { label: "Started", value: "07:42" },
      { label: "Elapsed", value: "1:02:05" },
      { label: "Avg HR", value: "141 bpm" },
      { label: "Max HR", value: "172 bpm" },
    ]);
  });

  test("leaves elapsed and average heart rate to the chart's readout when it is shown", () => {
    const a = record({ start_local: "2024-08-18T07:42:10", elapsed_time: 3725, avg_hr: 141, max_hr: 172 });
    expect(previewFacts(a, true).map((f) => f.label)).toEqual(["Started", "Max HR"]);
  });
});
