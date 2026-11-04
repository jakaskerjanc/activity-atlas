import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityCalendar, shownYear } from "./ActivityCalendar";
import { activityCalendar } from "../analytics";
import { record } from "../testFixtures";

// December 2023 through 2024, with one long day in August 2024.
const years = activityCalendar(
  [record({ ts: Date.UTC(2024, 7, 18, 9) / 1000, moving_time: 5 * 3600 })],
  Date.UTC(2023, 11, 1) / 1000,
  Date.UTC(2025, 0, 1) / 1000 - 1,
);

const render = () => renderToStaticMarkup(createElement(ActivityCalendar, { years }));

describe("ActivityCalendar", () => {
  test("shows only the newest year by default, one cell per day", () => {
    const html = render();
    expect(html.match(/<rect data-i=/g)).toHaveLength(366);
    expect(html).toContain('aria-label="2024: 5h 0m moving over 1 active day"');
    expect(html).not.toContain('aria-label="2023:');
  });

  test("offers a button per year, with the shown one pressed", () => {
    const html = render();
    expect(html).toMatch(/aria-pressed="true"[^>]*>2024</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>2023</);
  });

  test("shades each day by its moving time", () => {
    const html = render();
    expect(html.match(/fill:var\(--heat-4\)/g)).toHaveLength(1);
    expect(html.match(/fill:var\(--heat-0\)/g)).toHaveLength(365);
  });

  test("has a legend for the shade steps", () => {
    const html = render();
    for (const label of ["None", "&lt;1h", "1–2h", "2–4h", "4h+"]) expect(html).toContain(label);
  });

  test("renders nothing without years", () => {
    expect(renderToStaticMarkup(createElement(ActivityCalendar, { years: [] }))).toBe("");
  });
});

describe("shownYear", () => {
  test("is the picked year while the span has it", () => {
    expect(shownYear(years, 2023)?.year).toBe(2023);
  });

  test("falls back to the newest year when nothing is picked or the pick left the span", () => {
    expect(shownYear(years, null)?.year).toBe(2024);
    expect(shownYear(years, 2019)?.year).toBe(2024);
  });
});
