// Data-driven line-color for the activity map. Pure module (like stats.ts /
// filters.ts): given the loaded features it derives a stable value domain and,
// per color mode, produces a Mapbox GL `line-color` value plus a matching
// legend. No React / Mapbox-runtime deps — only the ExpressionSpecification
// type, which is erased at build time.

import type { ExpressionSpecification } from "mapbox-gl";
import type { ActivityFeature, Theme } from "./types";
import { formatDate } from "./format";
import { GRADE_MAX, gradeLegendStops, gradeRamp } from "./grade";

export const ACCENT = "#ff6b3d";
/** Routes whose colored value is unknown: grey, so they never read as the ramp's low end. */
export const NEUTRAL = "#7a7f8c";

export type ColorMode =
  | "uniform"
  | "recency"
  | "type"
  | "grade"
  | "speed"
  | "heat";

export const COLOR_MODES: { mode: ColorMode; label: string; hint: string }[] = [
  { mode: "uniform", label: "Plain", hint: "Every route in the accent color" },
  { mode: "type", label: "Type", hint: "By activity type" },
  { mode: "recency", label: "Recency", hint: "Older routes cool, recent ones warm" },
  { mode: "grade", label: "Grade", hint: "How steep each stretch is" },
  { mode: "speed", label: "Speed", hint: "Average speed of each activity" },
  { mode: "heat", label: "Heat", hint: "Brighter where routes overlap" },
];

// --- Palettes -------------------------------------------------------------
// Sequential ramps ordered low -> high. Recency uses a cool->warm temperature
// so old routes stay visible on the dark base; speed uses a viridis-like ramp
// (colorblind-safe). Grade colors each stretch along the route (grade.ts).

const RECENCY_STOPS = ["#3aa6c2", "#f0a35e", "#ff5230"];
/** Viridis on dark; on the light map its pale yellow end vanishes, so it stops at a deep gold. */
const SPEED_STOPS: Record<Theme, string[]> = {
  dark: ["#3b528b", "#21918c", "#fde725"],
  light: ["#3b528b", "#21918c", "#b89a00"],
};

/**
 * Heat's legend: lone routes read dim, corridors you repeat glow toward the full accent.
 * The map itself draws Heat in the accent at low opacity and lets overlaps add up.
 */
const HEAT_LEGEND_STOPS: Record<Theme, string[]> = {
  dark: ["#3a1a0e", ACCENT],
  light: ["#f6d3c5", ACCENT],
};

/**
 * One fixed color per activity type, used everywhere a type is colored: the map's Type
 * mode, the filter list's swatches and the analytics charts. None is the accent orange,
 * which keeps meaning "the app / the selection". Checked with the dataviz palette
 * validator (all pairs, protan/deutan) on each theme's panel surface: dark steps are
 * light enough to read on the dark map (Walk is a pale pink, not a dark magenta), light
 * steps deep enough to hold contrast on the light map and white cards.
 */
const TYPE_COLORS: Record<Theme, Record<string, string>> = {
  dark: { Run: "#2ec4b6", Ride: "#5b8cff", Hike: "#f2c230", Walk: "#f7a1e0" },
  light: { Run: "#14b3a1", Ride: "#3d6fe0", Hike: "#c99400", Walk: "#b14aa0" },
};
/** Types outside the main four, keyed by a hash of the name so they never shift. */
const EXTRA_TYPE_COLORS: Record<Theme, string[]> = {
  dark: ["#9085e9", "#a8d84a", "#e98a6b", "#a0a4ae", "#6fd3f7"],
  light: ["#6250d6", "#6e9a14", "#c4643f", "#7d828c", "#1f8fb8"],
};

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

/** The fixed color of an activity type, the same in every view. */
export function typeColor(type: string, theme: Theme = "dark"): string {
  const fixed = TYPE_COLORS[theme][type];
  if (fixed) return fixed;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  const extra = EXTRA_TYPE_COLORS[theme];
  return extra[h % extra.length];
}

function typeMatch(types: string[], theme: Theme): string | ExpressionSpecification {
  if (types.length === 0) return ACCENT;
  const expr: unknown[] = ["match", ["get", "type"]];
  for (const t of types) expr.push(t, typeColor(t, theme));
  expr.push(ACCENT); // fallback for any unexpected type
  return expr as unknown as ExpressionSpecification;
}

/**
 * The Mapbox `line-color` paint value for a mode. `uniform` and `heat` render the
 * single accent color (heat shows how often you've been somewhere through overlapping
 * see-through lines, not hue); the rest map a feature property onto a color ramp. Grade
 * reads the `grade` of grade-run features (grade.ts), so the map must be drawing those.
 */
export function lineColorExpression(
  mode: ColorMode,
  domain: ColorDomain,
  theme: Theme = "dark",
): string | ExpressionSpecification {
  switch (mode) {
    case "uniform":
    case "heat":
      return ACCENT;
    case "recency":
      return ramp(get("ts"), domain.tsMin, domain.tsMax, RECENCY_STOPS);
    case "grade":
      return whenKnown(["has", "grade"], gradeRamp());
    case "speed":
      return whenKnown(
        ["all", ["has", "distance"], ["has", "moving_time"]],
        ramp(speedExpr(), domain.speedMin, domain.speedMax, SPEED_STOPS[theme]),
      );
    case "type":
      return typeMatch(domain.types, theme);
  }
}

// --- Legend ---------------------------------------------------------------

export type Legend =
  | { kind: "none" }
  | { kind: "gradient"; stops: string[]; minLabel: string; maxLabel: string; midLabel?: string }
  | { kind: "categorical"; entries: { label: string; color: string }[] };

/** Legend view-model describing the active color mode's scale. */
export function legendFor(mode: ColorMode, domain: ColorDomain, theme: Theme = "dark"): Legend {
  switch (mode) {
    case "uniform":
      return { kind: "none" };
    case "heat":
      return { kind: "gradient", stops: HEAT_LEGEND_STOPS[theme], minLabel: "Rare", maxLabel: "Frequent" };
    case "recency":
      return {
        kind: "gradient",
        stops: RECENCY_STOPS,
        minLabel: formatDate(domain.tsMin),
        maxLabel: formatDate(domain.tsMax),
      };
    case "grade":
      return {
        kind: "gradient",
        stops: gradeLegendStops(),
        minLabel: `−${GRADE_MAX}% descent`,
        midLabel: "flat",
        maxLabel: `+${GRADE_MAX}% climb`,
      };
    case "speed":
      return {
        kind: "gradient",
        stops: SPEED_STOPS[theme],
        minLabel: `${Math.round(domain.speedMin)} km/h`,
        maxLabel: `${Math.round(domain.speedMax)} km/h`,
      };
    case "type":
      return {
        kind: "categorical",
        entries: domain.types.map((t) => ({ label: t, color: typeColor(t, theme) })),
      };
  }
}
