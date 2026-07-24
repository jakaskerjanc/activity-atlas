// Shared visual tokens for the Trace Atlas chrome. Text/control colors resolve to CSS
// variables (see index.css) so they flip between the dark and light themes via the
// data-theme attribute on <html>. The panel material itself is no longer CSS — it comes
// from liquid-glass-react, tuned per theme by glassMaterial() below.

import type { CSSProperties } from "react";
import type { Theme } from "../types";

// The route/mark accent as a literal — used where a real color string is required
// (Mapbox paint expressions can't read CSS vars). DOM styling uses var(--accent*) instead.
export const ACCENT = "#ff6b3d";
export const MONO = "'JetBrains Mono', monospace";

/** The subset of liquid-glass-react props that describes the material. */
export interface GlassMaterial {
  mode: "standard" | "polar" | "prominent" | "shader";
  displacementScale: number;
  blurAmount: number;
  saturation: number;
  aberrationIntensity: number;
  overLight: boolean;
}

/**
 * Glass tuning per theme. `blurAmount: 0` leaves only the library's blur floor,
 * `blur((overLight ? 12 : 4)px)`, so the panels refract rather than frost.
 *
 * Both themes therefore run with `overLight: false` — it is the only way down to the
 * 4px floor, and its other two effects are wanted here as well: it stops the library
 * halving `displacementScale` (so 45 means 45), and it swaps its hardcoded
 * `0 16px 70px rgba(0,0,0,.75)` shadow for a far lighter one, which suits a light theme
 * better anyway. Its third effect, the darkening overlays, never applied: those are
 * Tailwind-classed and this app has no Tailwind.
 */
export function glassMaterial(theme: Theme): GlassMaterial {
  return theme === "light"
    ? {
        mode: "shader",
        displacementScale: 45,
        blurAmount: 0,
        saturation: 180,
        aberrationIntensity: 2,
        overLight: false,
      }
    : {
        mode: "shader",
        displacementScale: 60,
        blurAmount: 0,
        saturation: 140,
        aberrationIntensity: 2,
        overLight: false,
      };
}

/** Small uppercase mono section eyebrow. */
export const eyebrow: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".2em",
  color: "var(--text-muted)",
  textTransform: "uppercase",
};
