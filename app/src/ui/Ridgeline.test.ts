import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Ridgeline } from "./Ridgeline";
import type { MonthRidge } from "../ridgeline";

const month = (year: number, m: number) => year * 12 + (m - 1);

const ridge = (m: number, props: Partial<MonthRidge> = {}): MonthRidge => ({
  month: m,
  count: 0,
  profiled: 0,
  gainM: undefined,
  signature: null,
  relief: 0,
  ...props,
});

const render = (ridges: MonthRidge[], isolatedMonth: number | null = null) =>
  renderToStaticMarkup(createElement(Ridgeline, { ridges, isolatedMonth, onPickMonth: () => {} }));

describe("Ridgeline", () => {
  const ridges = [
    ridge(month(2025, 12), { count: 2, profiled: 2, gainM: 18240, signature: [0, 400, 100], relief: 400 }),
    ridge(month(2026, 1)),
    ridge(month(2026, 2), { count: 1, profiled: 0, gainM: undefined }),
    ridge(month(2026, 3), { count: 3, profiled: 1, gainM: 120, signature: [0, 0, 0], relief: 0 }),
  ];

  test("one focusable row per month, oldest first, with month and gain", () => {
    const html = render(ridges);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "December 2025 · 2 activities · 18,240 m gain",
      "January 2026 · no activities",
      "February 2026 · 1 activity · elevation gain unknown",
      "March 2026 · 3 activities · 120 m gain",
    ]);
    expect(html.match(/role="button"/g)).toHaveLength(4);
    expect(html.match(/tabindex="0"/g)).toHaveLength(4);
    expect(html).toContain("18.2k m");
    expect(html).toContain("120 m");
    // The year shows on the first row and on January.
    expect(html).toContain("Dec<tspan");
    expect(html).toContain("Jan<tspan");
    expect(html).not.toContain("Feb<tspan");
  });

  test("months without a profile draw no silhouette and no NaN", () => {
    const html = render(ridges);
    // Only December and March have a signature: two outlines, two filled areas.
    expect(html.match(/<path d="M/g)).toHaveLength(4);
    expect(html).not.toContain("NaN");
  });

  test("the isolated month is pressed", () => {
    const html = render(ridges, month(2026, 3));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="March 2026[^"]*" aria-pressed="true"/);
  });

  test("states the scale, or that there is nothing to draw", () => {
    expect(render(ridges)).toContain("Tallest ridge 400 m");
    expect(render([ridge(month(2026, 1))])).toContain("No elevation profiles in this range.");
  });
});
