import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityCalendar, DayTip, shownYear, TIP_MAX_ACTIVITIES } from "./ActivityCalendar";
import { activityCalendar } from "../analytics";
import { stepsCalendar } from "../steps";
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

  test("leaves room for the hover outline around the last row and column", () => {
    const html = render();
    const [, , vbW, vbH] = html.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    // The outline is 1px outside the cell with a 1.5px stroke: 1.75px past each edge.
    const overhang = 1.75;
    const cells = [...html.matchAll(/<rect data-i="\d+" data-g="time" x="([\d.]+)" y="([\d.]+)" width="(\d+)" height="(\d+)"/g)];
    expect(cells).toHaveLength(366);
    const right = Math.max(...cells.map((m) => +m[1] + +m[3]));
    const bottom = Math.max(...cells.map((m) => +m[2] + +m[4]));
    expect(right + overhang).toBeLessThanOrEqual(vbW);
    expect(bottom + overhang).toBeLessThanOrEqual(vbH);
  });

  test("renders nothing without years", () => {
    expect(renderToStaticMarkup(createElement(ActivityCalendar, { years: [] }))).toBe("");
  });
});

describe("ActivityCalendar with steps", () => {
  // 2024-08-17 under the goal, 08-18 a big day, 08-19 missing, 08-20 in between.
  const steps = stepsCalendar(years, { v: 1, start: "2024-08-17", steps: [9000, 23000, null, 13000] });
  const html = renderToStaticMarkup(createElement(ActivityCalendar, { years, steps }));

  test("draws a steps grid for the same year, one cell per day with a total", () => {
    expect(html).toContain(">Moving time<");
    expect(html).toContain(">Steps<");
    expect(html.match(/data-g="steps"/g)).toHaveLength(3);
    expect(html).toContain("average 15.0k a day · 2 of 3 days at 10k or more");
  });

  test("rings a day under the goal and shades the rest", () => {
    const stepCells = [...html.matchAll(/<rect data-i="\d+" data-g="steps"[^>]*>/g)].map((m) => m[0]);
    expect(stepCells.filter((c) => c.includes("stroke:var(--accent)"))).toHaveLength(1);
    expect(stepCells.filter((c) => c.includes("fill:var(--heat-4)"))).toHaveLength(1);
    expect(html).toContain("Under 10k");
  });

  test("says so when the shown year has no step data", () => {
    const none = stepsCalendar(years, { v: 1, start: "2023-12-01", steps: [12000] });
    const out = renderToStaticMarkup(createElement(ActivityCalendar, { years, steps: none }));
    expect(out).toContain("No step data for 2024.");
    expect(out).not.toContain('data-g="steps"');
  });

  test("has no steps grid without step data", () => {
    expect(render()).not.toContain(">Steps<");
    expect(render()).not.toContain(">Moving time<");
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

describe("DayTip", () => {
  const dayWith = (n: number) => {
    const ts = (h: number) => Date.UTC(2024, 7, 18, h) / 1000;
    const [year] = activityCalendar(
      Array.from({ length: n }, (_, i) =>
        record({ id: `s:${i}`, name: `Activity ${i + 1}`, ts: ts(6 + i), moving_time: (i + 1) * 600 }),
      ),
      Date.UTC(2024, 0, 1) / 1000,
      Date.UTC(2025, 0, 1) / 1000 - 1,
    );
    return year.days.find((d) => d.ts === Date.UTC(2024, 7, 18) / 1000)!;
  };
  const tip = (n: number) => renderToStaticMarkup(createElement(DayTip, { day: dayWith(n) }));

  test("lists each activity's name and moving time", () => {
    const html = tip(2);
    expect(html).toContain("30m"); // the day's total
    expect(html).toMatch(/Activity 1<\/span><span[^>]*>10m</);
    expect(html).toMatch(/Activity 2<\/span><span[^>]*>20m</);
  });

  test("shows a dash for an unknown moving time", () => {
    const [year] = activityCalendar(
      [record({ name: "Gym", ts: Date.UTC(2024, 7, 18, 17) / 1000, moving_time: undefined })],
      Date.UTC(2024, 7, 18) / 1000,
      Date.UTC(2024, 7, 19) / 1000 - 1,
    );
    expect(renderToStaticMarkup(createElement(DayTip, { day: year.days[0] }))).toMatch(
      /Gym<\/span><span[^>]*>—</,
    );
  });

  test("cuts a long list with a count of the rest", () => {
    const html = tip(TIP_MAX_ACTIVITIES + 2);
    expect(html.match(/<li/g)).toHaveLength(TIP_MAX_ACTIVITIES + 1);
    expect(html).toContain("+2 more");
  });

  test("an empty day has no list", () => {
    const [year] = activityCalendar([], Date.UTC(2024, 7, 18) / 1000, Date.UTC(2024, 7, 19) / 1000 - 1);
    const html = renderToStaticMarkup(createElement(DayTip, { day: year.days[0] }));
    expect(html).toContain("No activity");
    expect(html).not.toContain("<ul");
  });
});
