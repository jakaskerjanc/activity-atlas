// liquid-glass-react always renders its container with
// `transform: translate(-50%, -50%)` and overwrites any transform we pass, so an
// anchor has to be pre-compensated by half the panel's measured size for the visual
// box to land where we want it.

import type { CSSProperties } from "react";

/** Where a panel's visual box should sit, in the map overlay's coordinate space. */
export type GlassAnchor =
  | { top: number; left: number }
  | { bottom: number; centerX: true };

export interface GlassSize {
  w: number;
  h: number;
}

/**
 * The position styles to hand the glass so its box lands on `anchor`.
 *
 * Always `top` + `left`, never `bottom`/`right`: the library copies only
 * position/top/left onto its rim and highlight layers, so an edge it doesn't read
 * leaves those layers stranded at their `left: 50%` / `top: 50%` default — visible as a
 * ghost rectangle in the middle of the map. A bottom anchor is therefore expressed as
 * `calc(100% - …)` against the full-viewport root.
 *
 * Values are strings because the library reads `style.top || "50%"` — a numeric 0 would
 * be treated as unset and silently re-center the panel.
 */
export function glassOffsets(anchor: GlassAnchor, size: GlassSize): CSSProperties {
  if ("bottom" in anchor) {
    // The -50% X translate already centers horizontally against left: 50%.
    return {
      top: `calc(100% - ${anchor.bottom + size.h / 2}px)`,
      left: "50%",
    };
  }
  return {
    top: `${anchor.top + size.h / 2}px`,
    left: `${anchor.left + size.w / 2}px`,
  };
}
