// Shared overlay geometry. Kept out of the components so panels that must lay
// themselves out relative to each other (e.g. bottom-center panels clearing the
// SidePanel) read one source of truth instead of duplicating numbers.

// Matches the old `.side-panel` CSS hide. Below this width the controls do not fit, so
// the panel is dropped entirely.
export const MOBILE_QUERY = "(max-width: 680px)";

// SidePanel's fixed placement. GlassPanel reads 2 * insetX wider than `width`.
export const SIDE_PANEL_TOP = 82;
export const SIDE_PANEL_LEFT = 24;
export const SIDE_PANEL_WIDTH = 296;
export const SIDE_PANEL_INSET_X = 18;

// Gap kept between SidePanel's right edge and a panel that clears it.
export const SIDE_PANEL_GAP = 24;

// The left offset a bottom-center panel must stay right of: SidePanel's right edge plus
// the gap. Bottom-center panels pass this as GlassPanel's `avoidLeft` so they never
// overlap SidePanel above the mobile breakpoint, where it is still rendered.
export const SIDE_PANEL_CLEARANCE =
  SIDE_PANEL_LEFT + SIDE_PANEL_WIDTH + 2 * SIDE_PANEL_INSET_X + SIDE_PANEL_GAP;
