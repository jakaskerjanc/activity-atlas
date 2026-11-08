import { describe, expect, test } from "vitest";
import { routesSvg } from "./RoutePreview";
import type { ActivityFeature } from "../types";

function route(coords: [number, number][]): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      id: "s:1",
      name: "Test",
      type: "Run",
      ts: 1000,
      start_date: "2024-08-18T09:58:55Z",
      distance: 1000,
      moving_time: 300,
      elevation_gain: 10,
      channels: [],
      sources: [],
    },
  };
}

const insets = { top: 62, right: 0, bottom: 0, left: 0 };

describe("routesSvg", () => {
  test("nothing to draw → null", () => {
    expect(routesSvg([], 400, 800, insets)).toBeNull();
    expect(routesSvg([route([[14.5, 46]])], 400, 800, insets)).toBeNull();
  });

  test("covers the map below the header, never the whole viewport", () => {
    const svg = routesSvg([route([[14.4, 46.0], [14.5, 46.05], [14.6, 46.1]])], 400, 800, insets)!;
    expect(svg).toMatchObject({ top: 62, width: 400, height: 738 });
    expect(svg.markup).toContain('viewBox="0 62 400 738"');
    expect(svg.markup).toMatch(/<path id="r" d="M[\d.]+ [\d.]+L/);
  });

  test("drops points closer than two pixels, but keeps each route's end", () => {
    // Ten points a few meters apart, then the end.
    const coords: [number, number][] = Array.from({ length: 10 }, (_, i) => [14.5 + i * 1e-6, 46]);
    coords.push([14.6, 46.1]);
    const svg = routesSvg([route(coords)], 400, 800, insets)!;
    const d = svg.markup.match(/<path id="r" d="([^"]+)"/)![1];
    expect(d.split("L")).toHaveLength(2);
  });
});
