// Data-driven line-color for the activity map. Pure module (like stats.ts /
// filters.ts): given the loaded features it derives a stable value domain and,
// per color mode, produces a Mapbox GL `line-color` value plus a matching
// legend. No React / Mapbox-runtime deps — only the ExpressionSpecification
// type, which is erased at build time.

import type { ExpressionSpecification } from "mapbox-gl";
import type { ActivityFeature } from "./types";
import { formatDate } from "./format";
import { GRADE_MAX, GRADE_STOPS, gradeRamp } from "./grade";

export const ACCENT = "#ff6b3d";
/** Routes whose colored value is unknown: grey, so they never read as the ramp's low end. */
export const NEUTRAL = "#7a7f8c";

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
// so old routes stay visible on the dark base; speed uses a viridis-like ramp
// (colorblind-safe). Elevation colors by grade along the route (grade.ts).

const RECENCY_STOPS = ["#3aa6c2", "#f0a35e", "#ff5230"];
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
  /** km/h (true min/max of the set) */
  speedMin: number;
  speedMax: number;
  /** distinct activity types, sorted (matches availableTypes order) */
  types: string[];
}

/** km/h from a feature's distance (m) and moving time (s); undefined when either is unknown. */
function speedKmh(f: ActivityFeature): number | undefined {
  const { distance, moving_time } = f.properties;
  if (distance == null || moving_time == null) return undefined;
  return (distance * 3.6) / Math.max(moving_time, 1);
}

/**
 * Derive the value domain used by the ramp modes from the given features —
 * callers pass the currently-visible set so the recency/speed ramps span
 * what's on screen. Uses true min/max (not percentiles) so the bounds are
 * honest and monotonic: narrowing the filter can never raise a max or lower a
 * min. Average speed is an aggregate value, so there are no instantaneous
 * spikes to clamp. Elevation needs no domain: % grade is absolute, so its
 * scale is fixed.
 */
export function computeDomain(features: ActivityFeature[]): ColorDomain {
  const types = new Set<string>();
  let tsMin = Infinity;
  let tsMax = -Infinity;
  let speedMin = Infinity;
  let speedMax = -Infinity;
  for (const f of features) {
    const p = f.properties;
    const s = speedKmh(f);
    if (p.ts < tsMin) tsMin = p.ts;
    if (p.ts > tsMax) tsMax = p.ts;
    // Unknown values stay out of the domain (they draw NEUTRAL, see lineColorExpression).
    if (s != null) {
      speedMin = Math.min(speedMin, s);
      speedMax = Math.max(speedMax, s);
    }
    types.add(p.type);
  }
  if (features.length === 0) {
    return { tsMin: 0, tsMax: 0, speedMin: 0, speedMax: 0, types: [] };
  }
  // A set where nobody has the value collapses to 0..0 rather than ±Infinity.
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  return {
    tsMin,
    tsMax,
    speedMin: finite(speedMin),
    speedMax: finite(speedMax),
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

/** `color` where the activity has the value, NEUTRAL where it doesn't. */
function whenKnown(test: unknown[], color: ExpressionSpecification): ExpressionSpecification {
  return ["case", test, color, NEUTRAL] as unknown as ExpressionSpecification;
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
 * hue); the rest map a feature property onto a color ramp. Elevation reads the
 * `grade` of grade-run features (grade.ts), so the map must be drawing those.
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
      return whenKnown(["has", "grade"], gradeRamp());
    case "speed":
      return whenKnown(
        ["all", ["has", "distance"], ["has", "moving_time"]],
        ramp(speedExpr(), domain.speedMin, domain.speedMax, SPEED_STOPS),
      );
    case "type":
      return typeMatch(domain.types);
  }
}

// --- Legend ---------------------------------------------------------------

export type Legend =
  | { kind: "none" }
  | { kind: "gradient"; stops: string[]; minLabel: string; maxLabel: string; midLabel?: string }
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
        stops: GRADE_STOPS,
        minLabel: `−${GRADE_MAX}% descent`,
        midLabel: "flat",
        maxLabel: `+${GRADE_MAX}% climb`,
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
