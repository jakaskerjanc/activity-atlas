import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Ridgeline } from "./Ridgeline";
import { POINTS_PER_DAY, type ClimbingRidgeline, type MonthRidge } from "../ridgeline";

const month = (year: number, m: number) => year * 12 + (m - 1);
const curve = (days: number, peak: number) =>
  Array.from({ length: days * POINTS_PER_DAY + 1 }, (_, i) => (i === 40 ? peak : 0));

const ridge = (m: number, props: Partial<MonthRidge> = {}): MonthRidge => ({
  month: m,
  days: 31,
  count: 0,
  gainM: undefined,
  daily: [],
  activeDays: [],
  biggestDay: undefined,
  curve: null,
  ...props,
});

const render = (ridges: MonthRidge[], isolatedMonth: number | null = null, maxM = 900) => {
  const ridgeline: ClimbingRidgeline = { ridges, maxM };
  return renderToStaticMarkup(
    createElement(Ridgeline, { ridgeline, isolatedMonth, onPickMonth: () => {} }),
  );
};

describe("Ridgeline", () => {
  const ridges = [
    ridge(month(2025, 12), {
      count: 2,
      gainM: 18240,
      activeDays: [3, 11],
      biggestDay: { day: 11, gainM: 900 },
      curve: curve(31, 900),
    }),
    ridge(month(2026, 1)),
    ridge(month(2026, 2), { days: 28, count: 1, activeDays: [5] }),
    ridge(month(2026, 3), { count: 3, gainM: 120, activeDays: [1, 2, 9], curve: curve(31, 60) }),
  ];

  test("one focusable row per month, oldest first, with month and gain", () => {
    const html = render(ridges);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "December 2025 · 2 activities · 18,240 m gain · biggest day Dec 11, 2025: 900 m",
      "January 2026 · no activities",
      "February 2026 · 1 activity · elevation gain unknown",
      "March 2026 · 3 activities · 120 m gain",
    ]);
    expect(html.match(/role="button"/g)).toHaveLength(4);
    expect(html.match(/tabindex="0"/g)).toHaveLength(4);
    expect(html).toContain("18.2k m");
    expect(html).toContain("Dec<tspan");
    expect(html).toContain("Jan<tspan");
    expect(html).not.toContain("Feb<tspan");
  });

  test("a dot per active day; silhouettes only where there is gain; no NaN", () => {
    const html = render(ridges);
    expect(html.match(/<circle/g)).toHaveLength(6);
    expect(html.match(/<path d="M/g)).toHaveLength(4);
    expect(html).not.toContain("NaN");
  });

  test("a day-of-month axis under the rows", () => {
    const html = render(ridges);
    expect(html).toContain(">day</text>");
    expect(html).toContain(">29</text>");
  });

  test("the isolated month is pressed", () => {
    const html = render(ridges, month(2026, 3));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="March 2026[^"]*" aria-pressed="true"/);
  });

  test("states the scale, or that there is nothing to draw", () => {
    expect(render(ridges)).toContain("the tallest peak is 900 m");
    expect(render([ridge(month(2026, 1))], null, 0)).toContain(
      "No activity in this range has a known elevation gain.",
    );
  });
});
