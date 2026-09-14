// Regression for the mobile crash: liquid-glass-react's "shader" mode builds a
// displacement-map canvas from the element's measured size and throws IndexSizeError at
// 0x0. The narrow-screen rule hid .side-panel with `display:none`, so the glass mounted
// at zero size and took the app down. SidePanel must simply not mount it below the
// breakpoint.

import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidePanel } from "./SidePanel";

interface MediaQueryListLike {
  matches: boolean;
  media: string;
  addEventListener(): void;
  removeEventListener(): void;
}

function stubViewport(matches: boolean) {
  (globalThis as { window?: unknown }).window = {
    matchMedia: (media: string): MediaQueryListLike => ({
      matches,
      media,
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const props = {
  theme: "dark" as const,
  availableTypes: ["Run"],
  typeCounts: { Run: 1 },
  enabledTypes: new Set(["Run"]),
  onToggleType: () => {},
  tsMin: 0,
  tsMax: 1,
  from: 0,
  to: 1,
  onFromChange: () => {},
  onToChange: () => {},
  colorMode: "recency" as const,
  colorDomain: {
    tsMin: 0,
    tsMax: 1,
    elevMin: 0,
    elevMax: 1,
    speedMin: 0,
    speedMax: 1,
    types: ["Run"],
  },
  onColorModeChange: () => {},
  onStartReplay: () => {},
  canReplay: true,
};

describe("SidePanel on narrow screens", () => {
  test("mounts nothing below the breakpoint, so the glass never measures 0x0", () => {
    stubViewport(true);
    expect(renderToStaticMarkup(createElement(SidePanel, props))).toBe("");
  });

  test("still renders the panel above the breakpoint", () => {
    stubViewport(false);
    expect(renderToStaticMarkup(createElement(SidePanel, props))).not.toBe("");
  });
});
