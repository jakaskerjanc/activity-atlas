// The selected activity's place and route rows: buttons, aria-expanded, and the open
// table's marks.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupRows } from "./GroupRows";
import type { PlaceLine, RouteTable } from "../routeGroup";

const at = (iso: string) => Date.parse(iso) / 1000;

const slavnik: PlaceLine = { id: "p1", name: "Slavnik", kind: "peak", count: 29 };
const table: RouteTable = {
  id: "r1",
  name: "Slavnik out-and-back via Skadanščina",
  rows: [
    { id: "b", ts: at("2025-08-21T08:00:00Z"), moving_time: 7500, current: true, fastest: false, outside: false },
    { id: "a", ts: at("2025-05-03T08:00:00Z"), moving_time: 7080, current: false, fastest: true, outside: false },
    { id: "c", ts: at("2024-10-14T08:00:00Z"), moving_time: 7920, pace_s_per_km: 306, current: false, fastest: false, outside: true },
  ],
};

const render = (place: PlaceLine | null, route: RouteTable | null, open: boolean) =>
  renderToStaticMarkup(
    createElement(GroupRows, { place, route, open, onToggle: () => {}, onPickPlace: () => {}, onSelect: () => {} }),
  );

// The text of an element, tags dropped (a missing element reads as empty).
const text = (html: string | undefined) => (html ?? "").replace(/<[^>]*>/g, "");

describe("GroupRows", () => {
  test("GroupRows renders the two rows and aria-expanded", () => {
    const closed = render(slavnik, table, false);
    const buttons = closed.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(text(buttons[0])).toContain("To Slavnik · 29 times");
    expect(text(buttons[0])).toContain("→");
    expect(buttons[0]).not.toContain("aria-expanded");
    expect(buttons[1]).toContain('aria-expanded="false"');
    expect(text(buttons[1])).toContain("Slavnik out-and-back via Skadanščina · 3×");
    expect(text(buttons[1])).toContain("▸");
    // Closed: no table.
    expect(closed).not.toContain("<li");

    const open = render(slavnik, table, true);
    expect(open).toContain('aria-expanded="true"');
    expect(text(open)).toContain("▾");
    const items = open.match(/<li[^>]*>(?:(?!<\/li>).)*<\/li>/g) ?? [];
    expect(items).toHaveLength(3);
    // Each row is a button: date, moving time, then its marks; pace only where given.
    expect(items.every((li) => li.includes("<button"))).toBe(true);
    expect(text(items[0])).toContain("Aug 21, 2025");
    expect(text(items[0])).toContain("2h 5m");
    expect(text(items[0])).toContain("this one");
    expect(items[0]).toContain('aria-current="true"');
    expect(text(items[1])).toContain("fastest");
    expect(text(items[1])).not.toContain("/km");
    expect(text(items[2])).toContain("5:06 /km");
    expect(text(items[2])).toContain("outside the filter");
    expect(text(items[0])).not.toContain("outside the filter");
  });

  test("a pass reads Over", () => {
    const html = render({ id: "p2", name: "Vršič", kind: "pass", count: 7 }, null, false);
    expect(text(html)).toContain("Over Vršič · 7 times");
    // Route row absent: one button only.
    expect(html.match(/<button/g)).toHaveLength(1);
    // A one-off reads "1 time", not "1 times".
    expect(text(render({ ...slavnik, count: 1 }, null, false))).toMatch(/To Slavnik · 1 time(?!s)/);
  });

  test("the marks column can shrink and wrap, so a phone doesn't clip 'fastest'", () => {
    const both: RouteTable = {
      ...table,
      rows: [{ ...table.rows[0], current: true, fastest: true, pace_s_per_km: 300 }, table.rows[2]],
    };
    const [row = ""] = render(null, both, true).match(/<li[^>]*>(?:(?!<\/li>).)*<\/li>/g) ?? [];
    // The last (marks) column is minmax(0, 1fr), not 1fr: it gives way instead of
    // pushing the row past the panel. Date, time and pace stay on one line each.
    expect(row).toContain("grid-template-columns:12ch 7ch 9ch minmax(0, 1fr)");
    expect(row).toContain("white-space:nowrap");
    // The marks wrap between "this one" and "fastest", never inside either.
    const note = row.match(/<span style="[^"]*white-space:normal[^"]*">(?:(?!<\/span><\/button>).)*/)?.[0] ?? "";
    expect(text(note)).toBe("← this one · fastest");
    // The arrow is decoration: screen readers hear "this one", not "left arrow".
    expect(row).toContain('<span aria-hidden="true">←</span>');
    // An unpaced table has the same shrinkable last column.
    const rides: RouteTable = { ...table, rows: table.rows.map(({ pace_s_per_km: _, ...row }) => row) };
    expect(render(null, rides, true)).toContain("grid-template-columns:12ch 7ch minmax(0, 1fr)");
  });

  test("neither row renders nothing", () => {
    expect(render(null, null, false)).toBe("");
  });
});
