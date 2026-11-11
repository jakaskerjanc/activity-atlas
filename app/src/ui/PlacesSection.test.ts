// The filter panel's places list: hidden without places, one aria-pressed button per
// place, and "+ N more" past the first eight.

import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { listToggle, PlacesSection } from "./PlacesSection";
import { createActivityFilter, togglePlace } from "../activityFilter";
import { record } from "../testFixtures";
import type { Place } from "../types";

const slavnik: Place = { id: "p1", name: "Slavnik", ele: 1028, kind: "peak" };
const vrsic: Place = { id: "p2", name: "Vršič", ele: 1611, kind: "pass" };

const render = (filter: ReturnType<typeof createActivityFilter>, places: readonly Place[]) =>
  renderToStaticMarkup(createElement(PlacesSection, { filter, places, onChange: () => {} }));

describe("PlacesSection", () => {
  test("no places renders nothing", () => {
    expect(render(createActivityFilter([record()]), [])).toBe("");
  });

  test("rows are aria-pressed buttons with name, height and count", () => {
    const filter = createActivityFilter([
      record({ id: "a", place: "p1" }),
      record({ id: "b", place: "p1" }),
      record({ id: "c", place: "p1" }),
      record({ id: "d", place: "p2" }),
    ]);
    const html = render(filter, [slavnik, vrsic]);
    expect(html).toContain("Places");
    expect(html).toMatch(/<label[^>]*>Search places<\/label>/);
    // One button per place: name, height, then the count last; most activities first.
    const row = (name: string, ele: string, count: number) =>
      new RegExp(`<button[^>]*aria-pressed="false"[^>]*>(?:(?!</button>).)*${name}(?:(?!</button>).)*${ele}(?:(?!</button>).)*>${count}</span></button>`);
    expect(html).toMatch(row("Slavnik", "1,028 m", 3));
    expect(html).toMatch(row("Vršič", "1,611 m", 1));
    expect(html.indexOf("Slavnik")).toBeLessThan(html.indexOf("Vršič"));
    expect(html).not.toContain('aria-pressed="true"');
    const picked = render(togglePlace(filter, "p1"), [slavnik, vrsic]);
    expect(picked).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Slavnik/);
    expect(picked).toMatch(/aria-pressed="false"[^>]*>(?:(?!<\/button>).)*Vršič/);
  });

  test("more button shows the hidden count and aria-expanded=false", () => {
    const places: Place[] = Array.from({ length: 11 }, (_, i) => ({
      id: `p${i}`,
      name: `Top ${i}`,
      ele: 500 + i,
      kind: "top",
    }));
    const filter = createActivityFilter(places.map((p, i) => record({ id: `a${i}`, place: p.id })));
    const html = render(filter, places);
    expect(html.match(/aria-pressed=/g)).toHaveLength(8);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>\+ 3 more<\/button>/);
    expect(html).not.toContain("Show fewer");
    // One toggle, after the last row.
    expect(html.match(/aria-expanded=/g)).toHaveLength(1);
    expect(html.indexOf("aria-expanded")).toBeGreaterThan(html.lastIndexOf("aria-pressed"));
  });

  // Opening and closing relabel one toggle, so the focused button stays in the DOM.
  test("one toggle: '+ N more' when collapsed, 'Show fewer' when open, none while searching", () => {
    expect(listToggle({ expanded: false, searching: false, more: 3, shown: 8 })).toBe("+ 3 more");
    expect(listToggle({ expanded: false, searching: false, more: 0, shown: 5 })).toBeNull();
    expect(listToggle({ expanded: true, searching: false, more: 0, shown: 11 })).toBe("Show fewer");
    // Open but no longer than the short list: nothing to close.
    expect(listToggle({ expanded: true, searching: false, more: 0, shown: 8 })).toBeNull();
    expect(listToggle({ expanded: true, searching: true, more: 0, shown: 11 })).toBeNull();
    expect(listToggle({ expanded: false, searching: true, more: 0, shown: 11 })).toBeNull();
  });
});
