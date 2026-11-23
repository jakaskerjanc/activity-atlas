import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunningFitness } from "./RunningFitness";
import { record } from "../testFixtures";
import type { ActivityRecord } from "../types";

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 6) / 1000;
/** A run every 4 days from day `from` to `to`, at an efficiency; each 10 km with 100 m climbed. */
const runs = (from: number, to: number, efficiency: number) =>
  Array.from({ length: Math.floor((to - from) / 4) + 1 }, (_, i) =>
    record({ id: `r${from + 4 * i}`, ts: T0 + (from + 4 * i) * DAY, efficiency }),
  );
/** Rendered as of the newest run's day, unless `now` (a day) says otherwise. */
const render = (activities: ActivityRecord[], opts: { all?: ActivityRecord[]; now?: number } = {}) =>
  renderToStaticMarkup(
    createElement(RunningFitness, {
      activities,
      all: opts.all ?? activities,
      now: opts.now != null ? T0 + opts.now * DAY : Math.max(...activities.map((a) => a.ts)),
    }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const dashed = (html: string) => html.match(/stroke-dasharray/g)?.length ?? 0;

// 1.2 m per beat is 5:33 /km at 150 bpm, 1.1 is 6:04, 1.3 is 5:08.
const yearOn = [...runs(0, 60, 1.1), ...runs(300, 420, 1.2)];

describe("RunningFitness", () => {
  test("leads with the line's latest value and how much faster it is than a year earlier", () => {
    const html = render(yearOn);
    expect(text(html)).toContain("5:33/km");
    // 333.3 against 363.6 s/km a year earlier.
    expect(text(html)).toContain("▲ 30\u00a0s/km faster than a year ago");
    expect(html).toContain("color:var(--success)");
    expect(html).toContain('title="6:04\u00a0/km in Feb 2025"');
    expect(html).toContain(
      'aria-label="The 3-month average of flat-ground pace at 150 bpm, corrected for climbing, over 47 runs, Jan 2025 to Mar 2026; now 5:33\u00a0/km; 1 break with too few runs"',
    );
  });

  test("slower than a year ago in a muted colour, never the alarm red; about the same without an arrow", () => {
    const slower = render([...runs(0, 60, 1.2), ...runs(300, 420, 1.1)]);
    expect(text(slower)).toContain("▼ 30\u00a0s/km slower than a year ago");
    expect(slower).not.toContain("var(--success)");
    const same = render([...runs(0, 60, 1.2), ...runs(300, 420, 1.201)]);
    expect(text(same)).toContain("About the same as a year ago");
    expect(same).not.toMatch(/[▲▼]/);
  });

  test("no comparison without a line a year earlier", () => {
    const html = render(runs(0, 120, 1.2));
    expect(text(html)).toContain("5:33/km");
    expect(html).not.toContain("a year ago");
  });

  test("says when the latest value is from before this week", () => {
    // The newest run is on day 420, 2 Mar 2026.
    expect(text(render(yearOn))).not.toContain("as of");
    expect(text(render(yearOn, { now: 426 }))).not.toContain("as of");
    expect(text(render(yearOn, { now: 450 }))).toContain("as of Mar 2");
    expect(text(render(yearOn, { now: 800 }))).toContain("as of Mar 2, 2026");
  });

  test("names the line's best value, under the headline and at its point on the chart", () => {
    const html = render([...runs(0, 120, 1.1), ...runs(124, 240, 1.3), ...runs(244, 360, 1.1)]);
    expect(text(html)).toContain("Best: 5:08\u00a0/km in");
    expect(html).toContain(">Best 5:08</text>");
    expect(html).toContain(">Now 6:04</text>");
  });

  test("only the line: no dot per run and no error band, just the two labelled points", () => {
    const html = render([...runs(0, 120, 1.1), ...runs(124, 240, 1.3), ...runs(244, 360, 1.1)]);
    expect(html.match(/<circle/g)?.length).toBe(2);
    // The latest point reads the same as the best: one marker, one label.
    const rising = render([...runs(0, 120, 1.1), ...runs(124, 240, 1.3)]);
    expect(rising.match(/<circle/g)?.length).toBe(1);
    expect(rising).not.toContain(">Best 5");
    expect(html).not.toContain("opacity=\"0.16\"");
  });

  test("bridges breaks inside the line with a dotted connector, but not the stretch before it starts", () => {
    // Every run sits in the stretch before the line has five runs, then a break.
    expect(dashed(render(runs(0, 120, 1.2)))).toBe(0);
    expect(dashed(render([...runs(0, 60, 1.2), ...runs(200, 260, 1.2)]))).toBe(1);
    const twice = render([...runs(0, 60, 1.2), ...runs(200, 260, 1.2), ...runs(400, 460, 1.2)]);
    expect(dashed(twice)).toBe(1);
    expect(twice.match(/stroke-dasharray="2 4"[^>]*/)?.[0]).toBeDefined();
    // One path for both connectors, a move to each.
    expect(twice.match(/d="(M[^"]*)"[^>]*stroke-dasharray/)?.[1].match(/M/g)?.length).toBe(2);
  });

  test("says what the number is, and that it isn't corrected when it can't be fitted", () => {
    // Every run climbs 10 m/km: nothing to fit a slope to.
    const html = text(render(runs(0, 120, 1.2)));
    expect(html).toContain(
      "Flat-ground pace at 150 bpm, corrected for climbing · 3-month average · an estimate from pace, heart rate and climbing, not VO2max.",
    );
    expect(html).toContain("Too few runs yet to fit a climb correction");
  });

  test("corrects each run for its climb, fitted over all runs whatever the filter shows", () => {
    // 5:33 /km on the flat (0 m/km), 5:43 /km climbing 10 m/km: a slope of 1 s/km per m/km.
    const flat = runs(0, 120, 1000 / (2.5 * 333)).map((r) => ({ ...r, elevation_gain: 0 }));
    const hilly = runs(2, 122, 1000 / (2.5 * 343)).map((r) => ({ ...r, id: `h${r.id}` }));
    const html = render([...flat, ...hilly]);
    expect(html).toContain("each run is credited 1.0\u00a0s/km per metre climbed per km");
    // Both kinds of run correct to 5:33, so the line does too.
    expect(html).toContain("now 5:33\u00a0/km");
    // Only the hilly runs visible: still corrected by the slope fitted over all of them.
    const filtered = render(hilly, { all: [...flat, ...hilly] });
    expect(filtered).toContain("credited 1.0\u00a0s/km");
    expect(filtered).toContain("now 5:33\u00a0/km");
  });

  test("leaves out other types and runs without a value; too few runs for a line says so", () => {
    const html = render([...runs(0, 12, 1.2), record({ id: "ride", type: "Ride", efficiency: 2 }), record({ id: "x" })]);
    expect(text(html)).toContain("Not enough runs yet for a 3-month average: it takes 5 within 3 months.");
    expect(html).not.toContain("<svg");
  });

  test("says so instead of drawing an empty chart", () => {
    expect(render([record({ type: "Ride" })])).toContain("No visible activity is a run.");
    expect(render([record({ type: "Run" })])).toContain("No visible run has enough heart rate");
    expect(render([record({ type: "Run" })])).not.toContain("<svg");
  });
});
