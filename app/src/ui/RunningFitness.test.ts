import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunningFitness } from "./RunningFitness";
import { record } from "../testFixtures";
import type { ActivityRecord } from "../types";

const render = (activities: ActivityRecord[], all: ActivityRecord[] = activities) =>
  renderToStaticMarkup(createElement(RunningFitness, { activities, all }));

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 6) / 1000;
/** A run every 4 days from day `from` to `to`, at an efficiency; each 10 km with 100 m climbed. */
const runs = (from: number, to: number, efficiency: number) =>
  Array.from({ length: Math.floor((to - from) / 4) + 1 }, (_, i) =>
    record({ id: `r${from + 4 * i}`, ts: T0 + (from + 4 * i) * DAY, efficiency }),
  );

describe("RunningFitness", () => {
  test("a dot per run and the rolling line, read against a year earlier", () => {
    // 1.2 m per beat is 5:33 /km at 150 bpm, 1.1 is 6:04.
    const html = render([...runs(0, 60, 1.1), ...runs(300, 420, 1.2)]);
    expect(html.match(/<circle/g)?.length).toBe(16 + 31);
    expect(html).toContain("Faster than a year ago: <strong");
    expect(html).toContain("5:33\u00a0/km</strong> now, 6:04\u00a0/km in Feb 2025");
    expect(html).toContain('aria-label="Flat-ground pace at 150 bpm, corrected for climbing, for 47 runs, Jan 2025 to Mar 2026; the rolling line ends at 5:33\u00a0/km"');
  });

  test("says what the number is, and that it isn't corrected when it can't be fitted", () => {
    // Every run climbs 10 m/km: nothing to fit a slope to.
    const html = render(runs(0, 120, 1.2));
    expect(html).toContain("An estimate from pace, heart rate and climbing, not a VO2max.");
    expect(html).toContain("Too few runs yet to fit a climb correction");
  });

  test("corrects each run for its climb, fitted over all runs whatever the filter shows", () => {
    // 5:33 /km on the flat (0 m/km), 5:43 /km climbing 10 m/km: a slope of 1 s/km per m/km.
    const flat = runs(0, 120, 1000 / (2.5 * 333)).map((r) => ({ ...r, elevation_gain: 0 }));
    const hilly = runs(2, 122, 1000 / (2.5 * 343)).map((r) => ({ ...r, id: `h${r.id}` }));
    const html = render([...flat, ...hilly]);
    expect(html).toContain("each run is credited 1.0\u00a0s/km per metre climbed per km");
    // Both kinds of run correct to 5:33, so the line does too.
    expect(html).toContain("the rolling line ends at 5:33\u00a0/km");
    // Only the hilly runs visible: still corrected by the slope fitted over all of them.
    const filtered = render(hilly, [...flat, ...hilly]);
    expect(filtered).toContain("credited 1.0\u00a0s/km");
    expect(filtered).toContain("the rolling line ends at 5:33\u00a0/km");
  });

  test("slower, or about the same, as a year ago", () => {
    expect(render([...runs(0, 60, 1.2), ...runs(300, 420, 1.1)])).toContain("Slower than a year ago");
    expect(render([...runs(0, 60, 1.2), ...runs(300, 420, 1.201)])).toContain("About the same as a year ago");
  });

  test("no sentence without a line a year earlier", () => {
    const html = render(runs(0, 120, 1.2));
    expect(html).toContain("<circle");
    expect(html).not.toContain("a year ago");
  });

  test("leaves out other types and runs without a value", () => {
    const html = render([...runs(0, 12, 1.2), record({ id: "ride", type: "Ride", efficiency: 2 }), record({ id: "x" })]);
    // Four runs: no line yet, so every circle is a run.
    expect(html.match(/<circle/g)?.length).toBe(4);
  });

  test("says so instead of drawing an empty chart", () => {
    expect(render([record({ type: "Ride" })])).toContain("No visible activity is a run.");
    expect(render([record({ type: "Run" })])).toContain("No visible run has enough heart rate");
    expect(render([record({ type: "Run" })])).not.toContain("<svg");
  });
});
