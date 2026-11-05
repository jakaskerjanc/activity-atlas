// Grade coloring for the map's Elevation color mode: each route is colored along its
// length by how steep it is there (climbs warm, descents cool). Pure module, like
// colors.ts.
//
// Mapbox cannot color one line feature from a per-point series (line-gradient is not
// data-driven, so one layer means one gradient), so each route is split into runs of
// one grade bucket. Each run is its own feature with a `grade` property that the
// ordinary data-driven line-color reads. Runs keep the activity's `id`, `type` and `ts`,
// so the activity filter, replay ordering and the id-keyed hover/selection
// feature-state work the same as on whole routes.
//
// Grade comes from the route profile (profiles.json: elevation every 100 m of distance,
// already smoothed at build time), not from the map line: the wire polyline has no
// elevation. A point on the line is matched to the profile by its share of the line's
// length.

import type { ExpressionSpecification } from "mapbox-gl";
import type { ActivityFeature, ActivityFeatureCollection, ProfilesFile } from "./types";

/** Grade (%) where the color scale saturates; steeper reads the same as this. */
export const GRADE_MAX = 15;
/** Width (%) of one grade bucket: runs split where the bucket changes. */
export const GRADE_BUCKET = 1.5;
/** Descent, flat and climb colors at -GRADE_MAX, 0 and +GRADE_MAX. */
export const GRADE_STOPS = ["#4cc9f0", "#666b76", "#ff3b30"];

/** What a run feature carries: enough for the filter, replay, highlight and color. */
export interface GradeRunProps {
  id: string;
  type: string;
  ts: number;
  /** % grade bucket, -GRADE_MAX..GRADE_MAX; absent when the activity has no profile */
  grade?: number;
}

export type GradeRunFeature = GeoJSON.Feature<GeoJSON.LineString, GradeRunProps>;

/** Where a run starts along its route (0..1 of the line's length) and its grade bucket. */
export interface RunStop {
  from: number;
  grade: number;
}

export interface GradeRoutes {
  collection: GeoJSON.FeatureCollection<GeoJSON.LineString, GradeRunProps>;
  /** Each profiled activity's runs in order, for the replay route's line-gradient. */
  stops: Map<string, RunStop[]>;
}

/**
 * The grade (%) at each profile point: rise over run between its two neighbours (one
 * neighbour at the ends). Taken over two steps rather than one so a single noisy
 * point cannot flip a colour.
 */
export function profileGrades(profile: number[], step: number): number[] {
  const n = profile.length;
  return profile.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    return hi > lo ? ((profile[hi] - profile[lo]) / ((hi - lo) * step)) * 100 : 0;
  });
}

/** Linear interpolation of per-point grades at `x` metres, held flat past either end. */
function gradeAt(grades: number[], step: number, x: number): number {
  const pos = x / step;
  if (pos <= 0) return grades[0];
  if (pos >= grades.length - 1) return grades[grades.length - 1];
  const i = Math.floor(pos);
  const t = pos - i;
  return grades[i] + (grades[i + 1] - grades[i]) * t;
}

/** A grade as its bucket: rounded to GRADE_BUCKET, clamped to ±GRADE_MAX, never -0. */
export function bucketGrade(g: number): number {
  const b = Math.round(g / GRADE_BUCKET) * GRADE_BUCKET;
  return Math.max(-GRADE_MAX, Math.min(GRADE_MAX, b)) || 0;
}

/** Metres between two [lng, lat] points (equirectangular: exact enough at route scale). */
function metres(a: GeoJSON.Position, b: GeoJSON.Position): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return R * Math.hypot(x, y);
}

interface Run {
  grade: number;
  /** distance along the line where the run starts, metres */
  start: number;
  coordinates: GeoJSON.Position[];
}

/**
 * Split one route into runs of one grade bucket. The line is cut into pieces no longer
 * than one profile step (the simplified wire line can have long straight segments whose
 * elevation still changes), each piece takes the grade at its midpoint, and neighbouring
 * pieces of the same bucket join up. Neighbouring runs share their boundary point, so
 * the drawn line stays continuous. `distance` (metres) is the activity's recorded
 * distance, which the profile is measured in; the line's own length can differ from it.
 */
export function splitRoute(
  coordinates: GeoJSON.Position[],
  profile: number[],
  step: number,
  distance?: number,
): { runs: Run[]; length: number } {
  const grades = profileGrades(profile, step);
  let length = 0;
  for (let i = 1; i < coordinates.length; i++) length += metres(coordinates[i - 1], coordinates[i]);
  const span = Math.max(distance ?? 0, (profile.length - 1) * step);
  const scale = length > 0 ? span / length : 0;

  const runs: Run[] = [];
  let along = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1];
    const b = coordinates[i];
    const seg = metres(a, b);
    const pieces = Math.max(1, Math.ceil((seg * scale) / step));
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces;
      const t1 = (k + 1) / pieces;
      const p0 = k === 0 ? a : lerp(a, b, t0);
      const p1 = k === pieces - 1 ? b : lerp(a, b, t1);
      const mid = (along + seg * ((t0 + t1) / 2)) * scale;
      const grade = bucketGrade(gradeAt(grades, step, mid));
      const last = runs[runs.length - 1];
      if (last && last.grade === grade) last.coordinates.push(p1);
      else runs.push({ grade, start: along + seg * t0, coordinates: [p0, p1] });
    }
    along += seg;
  }
  return { runs, length };
}

function lerp(a: GeoJSON.Position, b: GeoJSON.Position, t: number): GeoJSON.Position {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Every route as grade runs. An activity without a route profile (no altitude, or
 * shorter than one step) stays one whole feature with no `grade`, which draws neutral.
 */
export function gradeRoutes(data: ActivityFeatureCollection, file: ProfilesFile): GradeRoutes {
  const features: GradeRunFeature[] = [];
  const stops = new Map<string, RunStop[]>();
  for (const f of data.features) {
    const { id, type, ts } = f.properties;
    const profile = file.profiles[id];
    if (!profile) {
      features.push(runFeature(f, f.geometry.coordinates, { id, type, ts }));
      continue;
    }
    const { runs, length } = splitRoute(f.geometry.coordinates, profile, file.step, f.properties.distance);
    const mine: RunStop[] = [];
    for (const r of runs) {
      features.push(runFeature(f, r.coordinates, { id, type, ts, grade: r.grade }));
      const from = length > 0 ? r.start / length : 0;
      // line-gradient stops must strictly ascend; a run starting where the previous
      // one did (zero-length pieces) only replaces its color.
      const prev = mine[mine.length - 1];
      if (prev && from <= prev.from) prev.grade = r.grade;
      else mine.push({ from, grade: r.grade });
    }
    stops.set(id, mine);
  }
  return { collection: { type: "FeatureCollection", features }, stops };
}

function runFeature(
  f: ActivityFeature,
  coordinates: GeoJSON.Position[],
  properties: GradeRunProps,
): GradeRunFeature {
  return { type: "Feature", geometry: { ...f.geometry, coordinates }, properties };
}

// --- Color ----------------------------------------------------------------

/** The data-driven line-color over a run's `grade` (colors.ts sends grade-less features to NEUTRAL). */
export function gradeRamp(): ExpressionSpecification {
  const [down, flat, up] = GRADE_STOPS;
  return [
    "interpolate",
    ["linear"],
    ["get", "grade"],
    -GRADE_MAX,
    down,
    0,
    flat,
    GRADE_MAX,
    up,
  ] as unknown as ExpressionSpecification;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The ramp's color at a grade, as the style would interpolate it (linear RGB mix). */
export function gradeColor(grade: number): string {
  const g = Math.max(-GRADE_MAX, Math.min(GRADE_MAX, grade));
  const [down, flat, up] = GRADE_STOPS.map(hexRgb);
  const [from, to, t] = g < 0 ? [flat, down, -g / GRADE_MAX] : [flat, up, g / GRADE_MAX];
  const mix = from.map((c, i) => Math.round(c + (to[i] - c) * t));
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A line-gradient for one route's runs, so the single route drawing in replay (one
 * whole feature, trimmed as it draws) shows the same colors as its runs.
 */
export function lineGradient(stops: RunStop[]): ExpressionSpecification {
  const first = gradeColor(stops[0]?.grade ?? 0);
  if (stops.length < 2) {
    // step needs at least one stop; a one-color route is a flat interpolate.
    return ["interpolate", ["linear"], ["line-progress"], 0, first, 1, first] as unknown as ExpressionSpecification;
  }
  const expr: unknown[] = ["step", ["line-progress"], first];
  for (const s of stops.slice(1)) expr.push(s.from, gradeColor(s.grade));
  return expr as unknown as ExpressionSpecification;
}
