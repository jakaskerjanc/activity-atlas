import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivitySummary } from "./ActivitySummary";
import { record } from "../testFixtures";
import type { DetailFile } from "../types";

const detail: DetailFile = { v: 1, step: 10, t: [0, 10, 20, 30], d: [0, 40, 80, 120], alt: [300, 320, 360, 310], hr: [100, 120, 130, 125] };

const render = (over: Partial<Parameters<typeof ActivitySummary>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ActivitySummary, {
      activity: record({ detail: true }),
      detail: { status: "ready", detail },
      cursor: null,
      onCursor: () => {},
      ...over,
    }),
  );

describe("ActivitySummary", () => {
  test("stats, then what goes under them, then the charts", () => {
    const html = render({ children: createElement("p", null, "place rows") });
    const at = (s: string) => html.indexOf(s);
    expect(at(">Distance<")).toBeGreaterThan(-1);
    expect(at(">Distance<")).toBeLessThan(at("place rows"));
    expect(at("place rows")).toBeLessThan(at('aria-label="Elevation, m"'));
  });

  test("with zone limits the heart-rate line takes its zones' colors; without, the chart's own", () => {
    const zoned = render({ zoneLimits: [100, 120, 140, 160, 180] });
    expect(zoned).toContain('stroke="var(--zone-line-1)"');
    expect(render()).not.toContain("var(--zone-line-");
  });

  test("the heart-rate chart's title carries average and max", () => {
    const html = render({ activity: record({ detail: true, avg_hr: 121.6, max_hr: 168 }) });
    expect(html).toMatch(/Heart rate.*avg .*>122<.*max .*>168</);
  });

  test("a hike's cadence stays off the charts", () => {
    const cad: DetailFile = { ...detail, cad: [50, 55, 60, 52] };
    const html = (type: string) => render({ activity: record({ type, detail: true }), detail: { status: "ready", detail: cad } });
    expect(html("Run")).toContain('aria-label="Cadence, per min"');
    expect(html("Hike")).not.toContain('aria-label="Cadence, per min"');
  });
});
