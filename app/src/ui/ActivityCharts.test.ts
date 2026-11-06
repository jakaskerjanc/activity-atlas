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
      type,
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

  test("at rest the readout summarises the whole activity", () => {
    const html = render(null);
    expect(html).toContain("Whole activity");
    expect(html).toContain("bpm avg");
    expect(html).not.toContain(">–<");
  });

  test("under the cursor it reads that point, in the same chips", () => {
    const html = render(1);
    expect(html).toMatch(/At [\d.]+ km/);
    expect(html).toContain("123");
    expect(html).toContain("/km");
    expect(html).not.toContain("Whole activity");
  });

  test("draws a cursor line only with a cursor", () => {
    expect(render(1)).toContain("data-cursor");
    expect(render(null)).not.toContain("data-cursor");
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
