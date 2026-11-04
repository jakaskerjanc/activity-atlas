import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElevationProfiles } from "./ElevationProfiles";
import { profileChart, type ProfileLine } from "../elevationProfiles";

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
    createElement(ElevationProfiles, { chart, types: ["Hike", "Ride", "Run"] }),
  );

  test("axes in km and metres from the start", () => {
    expect(html).toContain('aria-label="Elevation of 3 activities against distance, overlaid"');
    expect(html).toContain("km</text>");
    expect(html).toMatch(/>\+\d+ m</);
    expect(html).toMatch(/>−\d+ m</);
    expect(html).toContain("0 m");
    expect(html).not.toContain("NaN");
  });

  test("a legend of the types drawn, most activities first", () => {
    expect(html.indexOf("Run 2")).toBeGreaterThan(-1);
    expect(html.indexOf("Run 2")).toBeLessThan(html.indexOf("Hike 1"));
    expect(html).not.toContain("Ride");
  });

  test("explains how to read it", () => {
    expect(html).toContain("Each line is one activity");
  });
});
