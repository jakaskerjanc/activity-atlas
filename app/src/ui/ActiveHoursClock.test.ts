import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveHoursClocks } from "./ActiveHoursClock";
import { activeHoursByWeekPart } from "../activeHours";
import { record } from "../testFixtures";

const render = (acts: Parameters<typeof activeHoursByWeekPart>[0]) =>
  renderToStaticMarkup(createElement(ActiveHoursClocks, { split: activeHoursByWeekPart(acts) }));

describe("ActiveHoursClocks", () => {
  const html = render([
    record({ start_local: "2026-11-06T18:00:00", elapsed_time: 5400 }), // Friday
    record({ start_local: "2026-11-07T10:00:00", elapsed_time: 1800 }), // Saturday
  ]);

  test("draws a weekday and a weekend clock, a hover track for every hour of each", () => {
    expect(html.match(/data-h="/g)).toHaveLength(48);
    expect(html.match(/fill:var\(--accent\)/g)).toHaveLength(3); // Fri 18, 19; Sat 10
  });

  test("captions each clock with its busiest hour and total", () => {
    expect(html).toContain("Weekdays");
    expect(html).toContain("busiest 18:00–19:00 · 1h 30m in all");
    expect(html).toContain("busiest 10:00–11:00 · 30m in all");
  });

  test("says when a clock has no time, and how many activities it couldn't place", () => {
    const out = render([record({ start_local: "2026-11-06T18:00:00", elapsed_time: 600 }), record({ start_local: undefined })]);
    expect(out).toContain("No time out");
    expect(out).toContain("1 activity without a start time or duration isn&#x27;t counted.");
    expect(html).not.toContain("counted.");
  });
});
