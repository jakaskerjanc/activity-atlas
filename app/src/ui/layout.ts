// Shared overlay geometry. Kept out of the components so dependent panels read one
// source of truth instead of duplicating numbers.

// Below this width both overlay panels start collapsed, so the map keeps the small
// viewport. A resize that crosses this boundary re-applies the collapsed state, which is
// what overrides a manual expand/collapse until the next crossing. The user can still
// expand either panel by clicking its edge tab.
export const COLLAPSE_QUERY = "(max-width: 1000px)";

// The edge tab that toggles collapse. It protrudes this far past the panel's leading
// edge, so it stays on screen after the panel has slid fully away.
export const PANEL_TAB_SIZE = 22;
export const PANEL_TAB_LONG = 52;

// SidePanel's fixed placement. GlassPanel reads 2 * insetX wider than `width`.
export const SIDE_PANEL_TOP = 82;
export const SIDE_PANEL_LEFT = 24;
export const SIDE_PANEL_WIDTH = 296;
export const SIDE_PANEL_INSET_X = 18;

// Gap kept between SidePanel's right edge and the bottom panel when both are open.
export const SIDE_PANEL_GAP = 24;

// Bottom-center panel geometry (InfoPanel / ReplayBar share it).
export const BOTTOM_PANEL_WIDTH = 420;
export const BOTTOM_PANEL_INSET_X = 18;

// How much of the bottom panel stays on screen when it is collapsed, on top of the 24px
// anchor that would otherwise sit below the viewport edge. Enough to keep the title strip
// (title + subtitle) readable, so a selected activity stays identifiable.
export const BOTTOM_PANEL_PEEK = 48;

// SidePanel's right edge, plus the gap: the strip a fitted track must stay right of when
// the side panel is open.
export const SIDE_PANEL_CLEARANCE =
  SIDE_PANEL_LEFT + SIDE_PANEL_WIDTH + 2 * SIDE_PANEL_INSET_X + SIDE_PANEL_GAP;

// The viewport width at which the centered bottom panel and the side panel stop
// overlapping: twice the bottom panel's half-box plus the side panel's reserved strip.
// At or above it both can stay open; below it the side panel auto-collapses (and can
// still be expanded by hand, overlapping the bottom panel).
export const BOTH_PANELS_MIN_WIDTH =
  2 * (SIDE_PANEL_CLEARANCE + BOTTOM_PANEL_WIDTH / 2 + BOTTOM_PANEL_INSET_X);
export const BOTH_PANELS_QUERY = `(min-width: ${BOTH_PANELS_MIN_WIDTH}px)`;

export interface FitPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Map padding around the header and bottom strip, plus a bare margin at the open edges.
const FIT_EDGE = 24;
const FIT_TOP = 90;
const FIT_BOTTOM = 80;

// Usable map area that must survive the padding. Mapbox's cameraForBounds solves for
// nothing (returns undefined, so the map refuses to move) once the padding consumes the
// whole viewport, which is exactly what a small window did.
const FIT_MIN_CONTENT = 48;

/**
 * Padding to fit a track into the strip left free by the panels. `left` reserves an open
 * side panel; each axis is then scaled down proportionally if the padding would otherwise
 * leave no usable map, so a narrow screen still centers instead of silently not moving.
 */
export function fitPadding(
  width: number,
  height: number,
  sidePanelExpanded: boolean,
): FitPadding {
  const [left, right] = fitAxis(
    sidePanelExpanded ? SIDE_PANEL_CLEARANCE + FIT_EDGE : FIT_EDGE,
    FIT_EDGE,
    width,
  );
  const [top, bottom] = fitAxis(FIT_TOP, FIT_BOTTOM, height);
  return { top, bottom, left, right };
}

/** Shrink a padding pair, proportionally, so it leaves at least FIT_MIN_CONTENT. */
function fitAxis(a: number, b: number, size: number): [number, number] {
  const sum = a + b;
  const budget = Math.max(0, size - FIT_MIN_CONTENT);
  if (sum <= budget || sum === 0) return [a, b];
  const k = budget / sum;
  return [a * k, b * k];
}
