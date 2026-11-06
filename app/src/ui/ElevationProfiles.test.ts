import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElevationProfiles } from "./ElevationProfiles";
import { profileChart, type ProfileLine } from "../elevationProfiles";
import { typeColor } from "../colors";

const line = (id: string, type: string, profile: number[]): ProfileLine => ({
  id,
  name: id,
  type,
  ts: 0,
  profile,
});

describe("ElevationProfiles", () => {
  const chart = profileChart(
    [
      line("a", "Hike", [0, 40, 80, 40, 0]),
      line("b", "Run", [0, -10, -20, 0, 10]),
      line("c", "Run", [0, 5, 5, 5, 0]),
    ],
    1000,
  )!;
  const html = renderToStaticMarkup(
    createElement(ElevationProfiles, { chart }),
  );

  test("axes in km and metres from the start", () => {
    expect(html).toContain('aria-label="Elevation of 3 activities against distance, overlaid"');
    expect(html).toContain("km</text>");
    expect(html).toMatch(/>\+\d+ m</);
    expect(html).toMatch(/>−\d+ m</);
    expect(html).toContain("0 m");
    expect(html).not.toContain("NaN");
  });

  test("the legend keeps the filter's type order, whatever this set's counts", () => {
    const ordered = renderToStaticMarkup(createElement(ElevationProfiles, { chart, order: ["Hike", "Run"] }));
    expect(ordered.search(/Hike<span/)).toBeLessThan(ordered.search(/Run<span/));
  });

  test("a legend of the types drawn, most activities first", () => {
    const run = html.search(/Run<span[^>]*>2</);
    const hike = html.search(/Hike<span[^>]*>1</);
    expect(run).toBeGreaterThan(-1);
    expect(run).toBeLessThan(hike);
    expect(html).not.toContain("Ride");
  });

  test("draws each type in its fixed color, the same as on the map", () => {
    expect(html).toContain(`background:${typeColor("Run")}`);
    expect(html).toContain(`background:${typeColor("Hike")}`);
  });

  test("explains how to read it, briefly", () => {
    expect(html).toContain("Climbs you repeat stand out where lines stack up");
  });

  test("no line runs past the top or bottom tick: the axis ends on whole ticks", () => {
    // Extents +80 / −20 m: the labelled ticks reach at least that far.
    const ticks = [...html.matchAll(/>([+−]?\d+) m</g)].map((m) => Number(m[1].replace("−", "-").replace("+", "")));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(80);
    expect(Math.min(...ticks)).toBeLessThanOrEqual(-20);
  });
});
