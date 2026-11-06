// Shared visual tokens for the Activity Atlas chrome. Colors resolve to CSS variables
// (see index.css) so they flip between the dark and light themes via the data-theme
// attribute on <html>. Sizes mirror the --fs-*/--sp-*/--r-* tokens in index.css, so an
// inline style and a stylesheet rule read the same scale.

import type { CSSProperties } from "react";

// The route/mark accent as a literal — used where a real color string is required
// (Mapbox paint expressions can't read CSS vars). DOM styling uses var(--accent*) instead.
export const ACCENT = "#ff6b3d";
/** Numbers only: stat values, axis ticks, dates in readouts. Labels are sans. */
export const MONO = "var(--font-mono)";

/** Type scale (px), as in index.css. */
export const FS = { "2xs": 10, xs: 11, sm: 12.5, md: 14, lg: 16, xl: 22, "2xl": 26 } as const;
/** Radii by hierarchy: controls < inner cards < panels < sheets. */
export const R = { sm: 8, md: 12, lg: 16, xl: 20 } as const;

/** The panel material, for boxes that sit in the page flow rather than in a GlassPanel. */
export const glass: CSSProperties = {
  background: "var(--panel-bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "var(--panel-shadow)",
};

/** A surface in the analytics page flow: opaque, so it needs no blur. */
export const card: CSSProperties = {
  background: "var(--bg-raised)",
  border: "1px solid var(--panel-border)",
  borderRadius: R.lg,
  padding: 20,
  minWidth: 0,
};

/** A section label inside a panel ("Activity types"): small, sentence case, semibold. */
export const sectionLabel: CSSProperties = {
  margin: 0,
  fontSize: FS.xs + 1,
  fontWeight: 600,
  color: "var(--text-soft)",
  letterSpacing: ".01em",
};

/** Secondary line under a title, and other muted supporting text. */
export const subtle: CSSProperties = {
  fontSize: FS.sm,
  color: "var(--text-muted)",
  lineHeight: 1.4,
};

/** Small muted mono text: axis ticks, legend counts. */
export const monoNote: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.xs,
  color: "var(--text-muted)",
};

const btnBase: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  borderRadius: R.sm,
  fontFamily: "inherit",
  fontWeight: 600,
  whiteSpace: "nowrap",
  lineHeight: 1,
};

/** A toggle pill (color modes, calendar years, replay speeds): accent-outlined when on. */
export function pillStyle(on: boolean): CSSProperties {
  return {
    ...btnBase,
    height: 30,
    padding: "0 10px",
    border: on ? "1px solid var(--accent)" : "1px solid var(--control-border)",
    background: on ? "var(--accent-tint)" : "var(--control-bg)",
    color: on ? "var(--pill-on-text)" : "var(--text-soft)",
    fontSize: FS.sm,
    fontWeight: on ? 600 : 500,
  };
}

/** The primary action: solid accent. */
export const primaryButton: CSSProperties = {
  ...btnBase,
  height: 36,
  padding: "0 14px",
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "var(--accent-ink)",
  fontSize: FS.sm + 0.5,
};

/** A secondary action: outlined, quiet. */
export const secondaryButton: CSSProperties = {
  ...btnBase,
  height: 32,
  padding: "0 12px",
  border: "1px solid var(--control-border)",
  background: "var(--control-bg)",
  color: "var(--text)",
  fontSize: FS.sm,
};

/** A square icon-only button (collapse, close). */
export const iconButton: CSSProperties = {
  ...btnBase,
  width: 30,
  height: 30,
  padding: 0,
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--text-muted)",
};

/** A 24px-grid stroked icon, in the house stroke style. */
export function iconProps(size = 16): {
  width: number;
  height: number;
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "round";
  strokeLinejoin: "round";
  "aria-hidden": true;
} {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
}
