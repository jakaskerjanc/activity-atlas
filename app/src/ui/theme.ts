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
 * Glass tuning per theme. `blurAmount: 0` leaves only the library's floor —
 * `blur((overLight ? 12 : 4)px)` — so the panels refract rather than frost.
 * `overLight` also halves the displacement, hence the larger scale in the light theme.
 *
 * Note the library's overLight darkening overlays are Tailwind-classed and this app has
 * no Tailwind, so overLight only affects blur, displacement and its own drop shadow.
 */
export function glassMaterial(theme: Theme): GlassMaterial {
  return theme === "light"
    ? {
        mode: "shader",
        displacementScale: 90,
        blurAmount: 0,
        saturation: 180,
        aberrationIntensity: 2,
        overLight: true,
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
