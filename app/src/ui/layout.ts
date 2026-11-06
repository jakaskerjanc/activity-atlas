// Shared overlay geometry. Kept out of the components so dependent panels (and the map's
// camera framing) read one source of truth instead of duplicating numbers.
//
// Desktop: the filters panel docks top-left, the detail panel (totals or the selected
// activity) docks top-right, the replay transport sits bottom-center, and the map's free
// area is the column between them. Phone: the filters open as an overlay from the header
// and the detail panel becomes a bottom sheet whose collapsed state is its header strip.

/**
 * At or below this width the phone layout applies (filters overlay, bottom sheet). It
 * covers portrait tablets too: a 404px docked panel there would leave the map a strip.
 */
export const MOBILE_MAX_WIDTH = 900;
/** The bottom sheet's widest, so on a tablet it reads as a sheet, not a slab. */
export const SHEET_MAX_WIDTH = 640;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/** The header bar's height; panels start just below it. */
export const HEADER_HEIGHT = 62;
/** Top of the docked panels. */
export const PANEL_TOP = 74;
/** Margin between a docked panel and the screen edge. */
export const PANEL_EDGE = 20;
/** Gap below the bottom-docked replay bar. */
export const PANEL_BOTTOM = 24;

/** Outer widths of the docked panels. */
export const SIDE_PANEL_WIDTH = 300;
export const DETAIL_PANEL_WIDTH = 404;
/** The replay transport's outer width on desktop. */
export const REPLAY_BAR_WIDTH = 460;

/** Screen x where the open filters panel ends. */
export const SIDE_PANEL_CLEARANCE = PANEL_EDGE + SIDE_PANEL_WIDTH;
/** Screen width the open detail panel takes from the right edge. */
export const DETAIL_PANEL_CLEARANCE = PANEL_EDGE + DETAIL_PANEL_WIDTH;

/** The narrowest map column worth keeping between the two docked panels. */
export const MIN_MAP_WIDTH = 380;

// At or above this width both docked panels stay open with a usable map between them;
// below it the filters panel starts collapsed (the header button still opens it).
export const BOTH_PANELS_MIN_WIDTH = SIDE_PANEL_CLEARANCE + DETAIL_PANEL_CLEARANCE + MIN_MAP_WIDTH;
export const BOTH_PANELS_QUERY = `(min-width: ${BOTH_PANELS_MIN_WIDTH}px)`;

/**
 * Screen space the chrome covers at each edge, in px from that edge: what the map must
 * keep a fitted route out from under.
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Breathing room between a fitted route and the chrome (or the bare screen edge). */
export const FIT_EDGE = 28;

// Usable map area that must survive the padding. Mapbox's cameraForBounds solves for
// nothing (returns undefined, so the map refuses to move) once the padding consumes the
// whole viewport, which is exactly what a small window did.
const FIT_MIN_CONTENT = 48;

/**
 * Which edges the chrome covers, for the current layout. `bottomPanel` is the measured
 * height of whatever sits on the bottom edge (the phone's sheet, or the replay bar), 0
 * when nothing does.
 */
export function chromeInsets(o: {
  mobile: boolean;
  sideOpen: boolean;
  detailOpen: boolean;
  bottomPanel: number;
}): Insets {
  if (o.mobile) {
    return { top: HEADER_HEIGHT, right: 0, bottom: o.bottomPanel, left: 0 };
  }
  return {
    top: HEADER_HEIGHT,
    left: o.sideOpen ? SIDE_PANEL_CLEARANCE : 0,
    right: o.detailOpen ? DETAIL_PANEL_CLEARANCE : 0,
    bottom: o.bottomPanel > 0 ? o.bottomPanel + PANEL_BOTTOM : 0,
  };
}

/**
 * Padding to fit a route into the area the chrome leaves free. `margin` adds room on
 * every side (for labels drawn past the route's ends). Each axis is then scaled down
 * proportionally if the padding would otherwise leave no usable map, so a small screen
 * still centers instead of silently not moving.
 */
export function fitPadding(width: number, height: number, insets: Insets, margin = 0): FitPadding {
  const [left, right] = fitAxis(
    insets.left + FIT_EDGE + margin,
    insets.right + FIT_EDGE + margin,
    width,
  );
  const [top, bottom] = fitAxis(
    insets.top + FIT_EDGE + margin,
    insets.bottom + FIT_EDGE + margin,
    height,
  );
  return { top, bottom, left, right };
}

/**
 * The fly-to offset that centers a fit in the padded area. Mapbox's cameraForBounds only
 * uses the padding to pick the zoom (spread evenly on both sides), so its center lands
 * mid-canvas; this shifts it by half the difference between opposite sides.
 */
export function fitOffset(p: FitPadding): [number, number] {
  return [(p.left - p.right) / 2, (p.top - p.bottom) / 2];
}

/** A stable key for insets, so effects refit only when the free area really changes. */
export function insetsKey(i: Insets): string {
  const r = (v: number) => Math.round(v / 8) * 8;
  return `${r(i.top)}:${r(i.right)}:${r(i.bottom)}:${r(i.left)}`;
}

/** Shrink a padding pair, proportionally, so it leaves at least FIT_MIN_CONTENT. */
function fitAxis(a: number, b: number, size: number): [number, number] {
  const sum = a + b;
  const budget = Math.max(0, size - FIT_MIN_CONTENT);
  if (sum <= budget || sum === 0) return [a, b];
  const k = budget / sum;
  return [a * k, b * k];
}
