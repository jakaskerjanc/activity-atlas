import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Header } from "./Header";
import type { View } from "./useView";

const render = (view: View) =>
  renderToStaticMarkup(
    createElement(Header, {
      theme: "dark",
      onToggleTheme: () => {},
      view,
      onViewChange: () => {},
    }),
  );

describe("Header page switch", () => {
  test("marks the open page as pressed", () => {
    const html = render("analytics");
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Analytics"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Map"/);
  });

  test("keeps labels the narrow layout can hide", () => {
    expect(render("map")).toContain('class="view-switch-label"');
  });
});
