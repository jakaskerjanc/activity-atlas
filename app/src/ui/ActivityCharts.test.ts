import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityCharts, detailMessage } from "./ActivityCharts";
import { buildProfile } from "../profile";
import type { DetailFile } from "../types";

const detail: DetailFile = {
  v: 1,
  step: 5,
  t: [0, 5, 10, 15],
  d: [0, 15, 30, 45],
  alt: [300, 310, 320, 315],
  hr: [100, 123, 140, 150],
  speed: [3, 3, 3, 3],
};

function render(cursor: number | null, type = "Run") {
  return renderToStaticMarkup(
    createElement(ActivityCharts, {
      detail,
      profile: buildProfile(detail, type)!,
      cursor,
      onCursor: () => {},
    }),
  );
}

describe("ActivityCharts", () => {
  test("renders one svg per chart", () => {
    expect(render(null).match(/<svg/g)).toHaveLength(3);
  });

  test("labels each chart", () => {
    const html = render(null);
    expect(html).toContain("Elevation");
    expect(html).toContain("Heart rate");
    expect(html).toContain("Pace");
    expect(render(null, "Ride")).toContain("Speed");
  });

  test("at rest the caption names the charts, and a title line can carry a whole-activity value", () => {
    const html = render(null);
    expect(html).toContain("Along the route");
    expect(html).not.toContain("Whole activity");
    const withRest = renderToStaticMarkup(
      createElement(ActivityCharts, {
        detail,
        profile: buildProfile(detail, "Run")!,
        cursor: null,
        onCursor: () => {},
        rests: { elevation: "High point 320 m" },
      }),
    );
    expect(withRest).toContain("High point 320 m");
  });

  test("under the cursor the caption says where, and each chart's title reads its value there", () => {
    const html = render(1);
    expect(html).toMatch(/At [\d.]+ km · 0:05/);
    expect(html).not.toContain("Along the route");
    // Elevation 310 m and heart rate 123 bpm, each beside its own chart.
    expect(html).toMatch(/>310<\/span> m</);
    expect(html).toMatch(/>123<\/span> bpm</);
  });

  test("draws a cursor line only with a cursor", () => {
    expect(render(1)).toContain("data-cursor");
    expect(render(null)).not.toContain("data-cursor");
  });

  test("side by side only in rows they fill, each with its own x axis; stacked on one otherwise", () => {
    const at = (minColumn: number) =>
      renderToStaticMarkup(
        createElement(ActivityCharts, { detail, profile: buildProfile(detail, "Run")!, cursor: null, onCursor: () => {}, minColumn }),
      );
    // The server render measures 400 px. Three charts at (400 - 2 × 24) / 3 = 117 px.
    const three = at(100);
    expect(three).toContain("repeat(3, minmax(0, 1fr))");
    expect(three.match(/<svg width="117"/g)).toHaveLength(3);
    expect(three.match(/>km</g)).toHaveLength(3);
    // Too narrow for three, and three don't fill rows of two: stacked, one axis, never 2 + 1.
    const stacked = at(180);
    expect(stacked).not.toContain("grid-template-columns");
    expect(stacked.match(/<svg width="400"/g)).toHaveLength(3);
    expect(stacked.match(/>km</g)).toHaveLength(1);
  });

  test("x axis reads km on a distance profile", () => {
    expect(render(null)).toContain("km");
  });
});

describe("detailMessage", () => {
  test("one muted line per state without charts", () => {
    expect(detailMessage({ status: "none" }, false)).toBe("No samples recorded for this activity.");
    expect(detailMessage({ status: "loading" }, false)).toBe("Loading samples…");
    expect(detailMessage({ status: "error" }, false)).toBe("Couldn't load samples.");
    expect(detailMessage({ status: "ready", detail }, false)).toBe("No samples recorded for this activity.");
    expect(detailMessage({ status: "ready", detail }, true)).toBeNull();
  });
});
