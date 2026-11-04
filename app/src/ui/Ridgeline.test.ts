import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Ridgeline } from "./Ridgeline";
import type { HillinessRidgeline, MonthRidge } from "../ridgeline";

const month = (year: number, m: number) => year * 12 + (m - 1);

const ridge = (m: number, props: Partial<MonthRidge> = {}): MonthRidge => ({
  month: m,
  count: 0,
  measured: 0,
  gainM: undefined,
  medianMPerKm: undefined,
  density: null,
  ...props,
});

const render = (ridges: MonthRidge[], isolatedMonth: number | null = null, maxDensity = 2) => {
  const ridgeline: HillinessRidgeline = { ridges, xMax: 100, maxDensity };
  return renderToStaticMarkup(
    createElement(Ridgeline, { ridgeline, isolatedMonth, onPickMonth: () => {} }),
  );
};

describe("Ridgeline", () => {
  const ridges = [
    ridge(month(2025, 12), { count: 2, measured: 2, gainM: 18240, medianMPerKm: 40, density: [0, 2, 1] }),
    ridge(month(2026, 1)),
    ridge(month(2026, 2), { count: 1 }),
    ridge(month(2026, 3), { count: 3, measured: 1, gainM: 120, medianMPerKm: 4, density: [1, 0, 0] }),
  ];

  test("one focusable row per month, oldest first, with month and gain", () => {
    const html = render(ridges);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "December 2025 · 2 activities · 18,240 m gain · median 40 m/km",
      "January 2026 · no activities",
      "February 2026 · 1 activity · elevation gain unknown",
      "March 2026 · 3 activities · 120 m gain · median 4 m/km",
    ]);
    expect(html.match(/role="button"/g)).toHaveLength(4);
    expect(html.match(/tabindex="0"/g)).toHaveLength(4);
    expect(html).toContain("18.2k m");
    expect(html).toContain("Dec<tspan");
    expect(html).toContain("Jan<tspan");
    expect(html).not.toContain("Feb<tspan");
  });

  test("months without a curve draw no silhouette and no NaN", () => {
    const html = render(ridges);
    // Only December and March have a curve: two outlines, two filled areas.
    expect(html.match(/<path d="M/g)).toHaveLength(4);
    expect(html).not.toContain("NaN");
  });

  test("an m/km axis under the rows", () => {
    expect(render(ridges)).toContain("m/km");
  });

  test("the isolated month is pressed", () => {
    const html = render(ridges, month(2026, 3));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="March 2026[^"]*" aria-pressed="true"/);
  });

  test("says when nothing can be drawn", () => {
    expect(render([ridge(month(2026, 1))], null, 0)).toContain(
      "No activity in this range has both a distance and an elevation gain.",
    );
  });
});
