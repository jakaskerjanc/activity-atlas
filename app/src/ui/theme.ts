// Shared visual tokens for the Trace Atlas chrome. Text/control colors resolve to CSS
// variables (see index.css) so they flip between the dark and light themes via the
// data-theme attribute on <html>. The panel material itself is also CSS — the
// --panel-bg/--panel-border/--panel-blur tokens in index.css.

import type { CSSProperties } from "react";

// The route/mark accent as a literal — used where a real color string is required
// (Mapbox paint expressions can't read CSS vars). DOM styling uses var(--accent*) instead.
export const ACCENT = "#ff6b3d";
export const MONO = "'JetBrains Mono', monospace";

/** Small uppercase mono section eyebrow. */
export const eyebrow: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".2em",
  color: "var(--text-muted)",
  textTransform: "uppercase",
};
