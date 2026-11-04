import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElevationHeatmap } from "./ElevationHeatmap";
import { heatmapGrid } from "../elevationHeatmap";

describe("ElevationHeatmap", () => {
  test("axes in km and metres from the start, and a note on the count", () => {
    const grid = heatmapGrid([[0, 40, 80, 40, 0], [0, -10, -20, 0, 10]], 1000)!;
    const html = renderToStaticMarkup(createElement(ElevationHeatmap, { grid, theme: "dark" }));
    expect(html).toContain('aria-label="Elevation of 2 activities against distance, overlaid"');
    expect(html).toContain("km</text>");
    expect(html).toContain("+50 m");
    expect(html).toContain("0 m");
    expect(html).toContain("2 activities, each measured from its start");
    expect(html).not.toContain("NaN");
  });
});
