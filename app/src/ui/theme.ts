// Shared visual tokens + the floating "glass" panel styling from the Trace Atlas design.
// Colors resolve to CSS variables (see index.css) so the whole chrome flips between the
// dark and light (Apple liquid glass) themes via the data-theme attribute on <html>.

import type { CSSProperties } from "react";

// The route/mark accent as a literal — used where a real color string is required
// (Mapbox paint expressions can't read CSS vars). DOM styling uses var(--accent*) instead.
export const ACCENT = "#ff6b3d";
export const MONO = "'JetBrains Mono', monospace";

const panelBase: CSSProperties = {
  position: "absolute",
  zIndex: 20,
  display: "flex",
  flexDirection: "column",
  borderRadius: 16,
  padding: "18px 18px",
  overflow: "hidden",
  border: "1px solid var(--panel-border)",
  background: "var(--panel-bg)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
  boxShadow: "var(--panel-shadow), var(--panel-highlight)",
  transition: "background .35s ease, border-color .35s ease, box-shadow .35s ease",
};

/** The single merged control + stats panel, sized to content, scrolls if tall. */
export const PANEL_STYLE: CSSProperties = {
  ...panelBase,
  top: 82,
  left: 24,
  width: 296,
  padding: "14px 16px",
  maxHeight: "calc(100% - 100px)",
  overflowY: "auto",
  overflowX: "hidden",
};

/** Activity info panel, floating bottom-center. */
export const INFO_PANEL_STYLE: CSSProperties = {
  ...panelBase,
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  width: 420,
  maxWidth: "calc(100% - 48px)",
};

/** Small uppercase mono section eyebrow. */
export const eyebrow: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".2em",
  color: "var(--text-muted)",
  textTransform: "uppercase",
};
