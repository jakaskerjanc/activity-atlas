// Shared visual tokens for the Trace Atlas chrome. Text/control colors resolve to CSS
// variables (see index.css) so they flip between the dark and light themes via the
// data-theme attribute on <html>. The panel material itself is also CSS — the
// --panel-bg/--panel-border/--panel-blur tokens in index.css.

import type { CSSProperties } from "react";

// The route/mark accent as a literal — used where a real color string is required
// (Mapbox paint expressions can't read CSS vars). DOM styling uses var(--accent*) instead.
export const ACCENT = "#ff6b3d";
export const MONO = "'JetBrains Mono', monospace";

/** The frosted panel material, for boxes that sit in the page flow rather than in a GlassPanel. */
export const glass: CSSProperties = {
  background: "var(--panel-bg)",
  border: "1px solid var(--panel-border)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
};

/** Small uppercase mono section eyebrow. */
export const eyebrow: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".2em",
  color: "var(--text-muted)",
  textTransform: "uppercase",
};

/** A toggle pill (color modes, calendar years): accent-outlined when on. */
export function pillStyle(on: boolean): CSSProperties {
  return {
    appearance: "none",
    border: on ? "1px solid var(--accent)" : "1px solid var(--control-border)",
    cursor: "pointer",
    textAlign: "center",
    padding: "5px 10px",
    borderRadius: 8,
    background: on ? "var(--accent-tint)" : "transparent",
    color: on ? "var(--pill-on-text)" : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 500,
    transition: "background .15s, border-color .15s",
  };
}
