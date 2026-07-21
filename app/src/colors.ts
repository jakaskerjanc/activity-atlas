// Data-driven line-color for the activity map. Pure module (like stats.ts /
// filters.ts): given the loaded features it derives a stable value domain and,
// per color mode, produces a Mapbox GL `line-color` value plus a matching
// legend. No React / Mapbox-runtime deps — only the ExpressionSpecification
// type, which is erased at build time.

import type { ExpressionSpecification } from "mapbox-gl";
import type { ActivityFeature } from "./types";
import { formatDate } from "./format";

export const ACCENT = "#ff6b3d";

export type ColorMode =
  | "uniform"
  | "recency"
  | "type"
  | "elevation"
  | "speed"
  | "heat";

export const COLOR_MODES: { mode: ColorMode; label: string }[] = [
  { mode: "uniform", label: "Uniform" },
  { mode: "recency", label: "Recency" },
  { mode: "type", label: "Type" },
  { mode: "elevation", label: "Elevation" },
  { mode: "speed", label: "Speed" },
  { mode: "heat", label: "Heat" },
];

// --- Palettes -------------------------------------------------------------
// Sequential ramps ordered low -> high. Recency uses a cool->warm temperature
// so old routes stay visible on the dark base; elevation uses ColorBrewer
// YlOrRd and speed uses a viridis-like ramp (both colorblind-safe sequences).

const RECENCY_STOPS = ["#3aa6c2", "#f0a35e", "#ff5230"];
const ELEVATION_STOPS = ["#ffeda0", "#feb24c", "#f03b20"];
const SPEED_STOPS = ["#3b528b", "#21918c", "#fde725"];

/** Qualitative palette for per-type coloring, assigned by sorted type order. */
const TYPE_PALETTE = [
  "#ff6b3d",
  "#4cc9f0",
  "#8ac926",
  "#ffca3a",
  "#c77dff",
  "#ff5da2",
  "#00bbf9",
  "#f15bb5",
];

// --- Domain ---------------------------------------------------------------

export interface ColorDomain {
  tsMin: number;
  tsMax: number;
  /** meters of elevation gain (5th/95th percentile — outlier-resistant) */
  elevMin: number;
  elevMax: number;
  /** km/h (5th/95th percentile) */
  speedMin: number;
  speedMax: number;
  /** distinct activity types, sorted (matches availableTypes order) */
  types: string[];
}

/** km/h from a feature's distance (m) and moving time (s). */
function speedKmh(f: ActivityFeature): number {
  return (f.properties.distance * 3.6) / Math.max(f.properties.moving_time, 1);
}

/** Linear-interpolated percentile of a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Derive the value domain used by the ramp modes from the given features —
 * callers pass the currently-visible set so the recency/elevation/speed ramps
 * span what's on screen. Elevation and speed use 5th/95th percentiles so a
 * single monster climb / GPS-glitch speed doesn't wash out the whole ramp.
 */
export function computeDomain(features: ActivityFeature[]): ColorDomain {
  const ts: number[] = [];
  const elev: number[] = [];
  const speed: number[] = [];
  const types = new Set<string>();
  for (const f of features) {
    ts.push(f.properties.ts);
    elev.push(f.properties.elevation_gain);
    speed.push(speedKmh(f));
    types.add(f.properties.type);
  }
  const elevSorted = [...elev].sort((a, b) => a - b);
  const speedSorted = [...speed].sort((a, b) => a - b);
  return {
    tsMin: ts.length ? Math.min(...ts) : 0,
    tsMax: ts.length ? Math.max(...ts) : 0,
    elevMin: percentile(elevSorted, 0.05),
    elevMax: percentile(elevSorted, 0.95),
    speedMin: percentile(speedSorted, 0.05),
    speedMax: percentile(speedSorted, 0.95),
    types: [...types].sort(),
  };
}

// --- Expressions ----------------------------------------------------------

/** `["get", prop]` typed as an expression. */
function get(prop: string): ExpressionSpecification {
  return ["get", prop] as unknown as ExpressionSpecification;
}

/** km/h computed inside the style: distance*3.6 / max(moving_time, 1). */
function speedExpr(): ExpressionSpecification {
  return [
    "/",
    ["*", ["get", "distance"], 3.6],
    ["max", ["get", "moving_time"], 1],
  ] as unknown as ExpressionSpecification;
}

/**
 * Build an `interpolate` ramp over [lo, hi] with the colors spread evenly.
 * Guards against lo >= hi (degenerate domain), which interpolate rejects.
 */
function ramp(
  input: ExpressionSpecification,
  lo: number,
  hi: number,
  stops: string[],
): ExpressionSpecification {
  const min = lo;
  const max = hi > lo ? hi : lo + 1;
  const n = stops.length - 1;
  const expr: unknown[] = ["interpolate", ["linear"], input];
  stops.forEach((color, i) => {
    expr.push(min + ((max - min) * i) / n, color);
  });
  return expr as unknown as ExpressionSpecification;
}

/** Deterministic categorical color per activity type (wraps the palette). */
export function typeColor(type: string, types: string[]): string {
  const i = types.indexOf(type);
  return TYPE_PALETTE[(i < 0 ? 0 : i) % TYPE_PALETTE.length];
}

function typeMatch(types: string[]): string | ExpressionSpecification {
  if (types.length === 0) return ACCENT;
  const expr: unknown[] = ["match", ["get", "type"]];
  for (const t of types) expr.push(t, typeColor(t, types));
  expr.push(ACCENT); // fallback for any unexpected type
  return expr as unknown as ExpressionSpecification;
}

/**
 * The Mapbox `line-color` paint value for a mode. `uniform` and `heat` render
 * a single accent color (heat conveys frequency through overlap density, not
 * hue); the rest map a feature property onto a color ramp.
 */
export function lineColorExpression(
  mode: ColorMode,
  domain: ColorDomain,
): string | ExpressionSpecification {
  switch (mode) {
    case "uniform":
    case "heat":
      return ACCENT;
    case "recency":
      return ramp(get("ts"), domain.tsMin, domain.tsMax, RECENCY_STOPS);
    case "elevation":
      return ramp(get("elevation_gain"), domain.elevMin, domain.elevMax, ELEVATION_STOPS);
    case "speed":
      return ramp(speedExpr(), domain.speedMin, domain.speedMax, SPEED_STOPS);
    case "type":
      return typeMatch(domain.types);
  }
}

// --- Legend ---------------------------------------------------------------

export type Legend =
  | { kind: "none" }
  | { kind: "gradient"; stops: string[]; minLabel: string; maxLabel: string }
  | { kind: "categorical"; entries: { label: string; color: string }[] };

/** Legend view-model describing the active color mode's scale. */
export function legendFor(mode: ColorMode, domain: ColorDomain): Legend {
  switch (mode) {
    case "uniform":
      return { kind: "none" };
    case "heat":
      // Overlap density: lone routes read dim, repeated corridors saturate.
      return { kind: "gradient", stops: ["#3a1a0e", ACCENT], minLabel: "rare", maxLabel: "frequent" };
    case "recency":
      return {
        kind: "gradient",
        stops: RECENCY_STOPS,
        minLabel: formatDate(domain.tsMin),
        maxLabel: formatDate(domain.tsMax),
      };
    case "elevation":
      return {
        kind: "gradient",
        stops: ELEVATION_STOPS,
        minLabel: `${Math.round(domain.elevMin)} m`,
        maxLabel: `${Math.round(domain.elevMax)} m`,
      };
    case "speed":
      return {
        kind: "gradient",
        stops: SPEED_STOPS,
        minLabel: `${Math.round(domain.speedMin)}`,
        maxLabel: `${Math.round(domain.speedMax)} km/h`,
      };
    case "type":
      return {
        kind: "categorical",
        entries: domain.types.map((t) => ({ label: t, color: typeColor(t, domain.types) })),
      };
  }
}
