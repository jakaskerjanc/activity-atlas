// Build the display files in app/public/data/ from the SQLite database at
// DB_PATH (default data/activities.sqlite, synced from R2, or the committed
// data/demo/activities.sqlite when that does not exist). See
// docs/2026-11-04-display-files-design.md. No network.
//
//   routes.json         v4  route polylines keyed by activity id (10 m Douglas–Peucker)
//   activities.json     v1  every visible activity's numbers; unknown values left out
//   activity/<id>.json  v1  downsampled samples, loaded when an activity is opened
//   profiles.json       v1  every activity's elevation every 100 m, for the analytics profiles chart
//   steps.json          v1  Garmin's daily step totals, for the analytics steps calendar
//   places.json         v1  places reached and named same-route groups; no coordinates
//
// Hidden and deleted activities never reach these files, and the folder is
// emptied before each write so a stale file cannot survive. The step totals are
// the only wellness value published: nothing else from daily_stats is read.

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import { isUsable, toRecord, type ActivityRow } from "./numbers.ts";
import { decodeChannel, type StreamChannel } from "./codec.ts";
import { buildDetail, type Streams } from "./detail.ts";
import { PROFILE_STEP_M, PROFILES_VERSION, routeProfile } from "./routeProfile.ts";
import type {
  ActivitiesFile,
  ActivitySource,
  DetailFile,
  Place,
  PlacesFile,
  ProfilesFile,
  RouteName,
  RoutesFile,
  StepsFile,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONAL_DB_PATH = resolve(__dirname, "../data/activities.sqlite");
const DEMO_DB_PATH = resolve(__dirname, "../data/demo/activities.sqlite");

/**
 * The database main() builds from when DB_PATH is unset: the personal one when
 * it exists, else the committed demo database, else the personal path (which
 * readDisplayFiles then reports as missing).
 */
export function defaultDbPath(personal = PERSONAL_DB_PATH, demo = DEMO_DB_PATH): string {
  return existsSync(personal) || !existsSync(demo) ? personal : demo;
}

const DB_PATH = process.env.DB_PATH || defaultDbPath();
export const OUT_DIR = resolve(__dirname, "../app/public/data");
const LEGACY_TRACKS = resolve(__dirname, "../app/public/tracks.json");

export const ROUTES_VERSION = 4;
export const ACTIVITIES_VERSION = 1;
export const STEPS_VERSION = 1;
export const PLACES_VERSION = 1;
/** Douglas–Peucker tolerance (meters) applied to the stored line for the wire. */
const SIMPLIFY_TOLERANCE_M = Number(process.env.SIMPLIFY_TOLERANCE_M) || 10;

export interface Stats {
  rawPoints: number;
  keptPoints: number;
}

export interface DisplayFiles {
  routes: RoutesFile;
  activities: ActivitiesFile;
  details: Map<string, DetailFile>;
  profiles: ProfilesFile;
  steps: StepsFile;
  places: PlacesFile;
  stats: Stats;
}

/** Simplified wire polyline, or null when the stored line has under 2 points. */
function wireRoute(stored: string, stats: Stats): string | null {
  if (!stored) return null;
  let coords = polyline.decode(stored).map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) return null;
  stats.rawPoints += coords.length;
  coords = simplifyLngLat(coords, SIMPLIFY_TOLERANCE_M);
  stats.keptPoints += coords.length;
  return polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
}

const PROVIDER_ORDER = ["strava", "garmin"] as const;

/** Live (not deleted) sources per activity, Strava first. */
function liveSources(db: Database.Database): Map<string, ActivitySource[]> {
  const rows = db
    .prepare(
      "SELECT activity_id, provider, provider_activity_id FROM activity_sources " +
        "WHERE deleted_at IS NULL ORDER BY activity_id, provider_activity_id",
    )
    .all() as { activity_id: string; provider: string; provider_activity_id: string }[];
  const byId = new Map<string, ActivitySource[]>();
  for (const r of rows) {
    const provider = PROVIDER_ORDER.find((p) => p === r.provider);
    if (!provider) continue; // the wire format only knows strava and garmin
    const list = byId.get(r.activity_id) ?? [];
    list.push({ provider, id: r.provider_activity_id });
    byId.set(r.activity_id, list);
  }
  for (const list of byId.values()) {
    list.sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
  }
  return byId;
}

/** Stream channels a detail file is built from. */
const DETAIL_CHANNELS = ["time", "distance", "lat", "lon", "altitude", "hr", "speed", "cadence"] as const;

/** The detail file for one streams row, or null (no row, or nothing worth charting). */
function readDetail(stmt: Database.Statement, sha: string | null): DetailFile | null {
  if (!sha) return null;
  const row = stmt.get(sha) as Record<StreamChannel, Buffer | null> | undefined;
  if (!row?.time) return null;
  const streams: Partial<Record<StreamChannel, (number | null)[]>> = {};
  for (const c of DETAIL_CHANNELS) {
    const blob = row[c];
    if (blob) streams[c] = decodeChannel(c, blob);
  }
  return buildDetail(streams as Streams);
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The daily step totals, from daily_stats.date and .steps only. The newest date is left
 * out: it is the day the fetch ran, so its total was still growing. A missing date or a
 * total that isn't a positive number (0 means the watch recorded nothing) is null. A
 * database without daily_stats (the demo, an older schema) has no step data.
 */
export function readSteps(db: Database.Database): StepsFile {
  const none: StepsFile = { v: STEPS_VERSION, steps: [] };
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_stats'")
    .get();
  if (!table) return none;
  const rows = db
    .prepare("SELECT date, steps FROM daily_stats WHERE date IS NOT NULL ORDER BY date")
    .all() as { date: string; steps: number | null }[];
  const known = rows
    .slice(0, -1)
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && typeof r.steps === "number" && r.steps > 0);
  if (known.length === 0) return none;
  const first = Date.parse(known[0].date);
  const last = Date.parse(known[known.length - 1].date);
  const steps: (number | null)[] = new Array((last - first) / DAY_MS + 1).fill(null);
  for (const r of known) steps[(Date.parse(r.date) - first) / DAY_MS] = Math.round(r.steps as number);
  return { v: STEPS_VERSION, start: isoDay(first), steps };
}

const hasTable = (db: Database.Database, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * places.json and each visible activity's place and route ids, from the places,
 * route_groups and activity_groups tables (schema v5). Only visible activities count:
 * a place needs one, a route group two, and placeOf/routeOf map only those. A database
 * without the tables (older than v5) has no places or routes.
 */
export function readPlaces(db: Database.Database): {
  file: PlacesFile;
  placeOf: Map<string, string>;
  routeOf: Map<string, string>;
} {
  const file: PlacesFile = { v: PLACES_VERSION, places: [], routes: [] };
  const placeOf = new Map<string, string>();
  const routeOf = new Map<string, string>();
  if (!["places", "route_groups", "activity_groups"].every((t) => hasTable(db, t))) {
    return { file, placeOf, routeOf };
  }
  const rows = db
    .prepare(
      "SELECT g.activity_id, g.place_id, g.route_id FROM activity_groups g " +
        "JOIN activities a ON a.id = g.activity_id WHERE a.visible = 1",
    )
    .all() as { activity_id: string; place_id: string | null; route_id: string | null }[];
  const routeSize = new Map<string, number>();
  for (const r of rows) if (r.route_id != null) routeSize.set(r.route_id, (routeSize.get(r.route_id) ?? 0) + 1);
  const places = new Map(
    (db.prepare("SELECT id, name, ele, kind FROM places ORDER BY id").all() as Place[]).map((p) => [p.id, p]),
  );
  const routes = new Map(
    (db.prepare("SELECT id, name FROM route_groups ORDER BY id").all() as RouteName[])
      .filter((r) => (routeSize.get(r.id) ?? 0) >= 2)
      .map((r) => [r.id, r]),
  );
  for (const r of rows) {
    if (r.place_id != null && places.has(r.place_id)) placeOf.set(r.activity_id, r.place_id);
    if (r.route_id != null && routes.has(r.route_id)) routeOf.set(r.activity_id, r.route_id);
  }
  const reached = new Set(placeOf.values());
  file.places = [...places.values()].filter((p) => reached.has(p.id));
  file.routes = [...routes.values()];
  return { file, placeOf, routeOf };
}

function emptyFiles(stats: Stats): DisplayFiles {
  return {
    routes: { v: ROUTES_VERSION, routes: {} },
    activities: { v: ACTIVITIES_VERSION, activities: [] },
    details: new Map(),
    profiles: { v: PROFILES_VERSION, step: PROFILE_STEP_M, profiles: {} },
    steps: { v: STEPS_VERSION, steps: [] },
    places: { v: PLACES_VERSION, places: [], routes: [] },
    stats,
  };
}

/**
 * Query the database and build every display file in memory. A missing database
 * (a fork with neither R2 nor a demo database) yields empty files and a warning.
 */
export function readDisplayFiles(
  dbPath: string,
  warn: (message: string) => void = console.warn,
): DisplayFiles {
  const stats: Stats = { rawPoints: 0, keptPoints: 0 };
  if (!existsSync(dbPath)) {
    warn(
      `No database at ${dbPath}; writing empty display files. Import an export ` +
        "(`pnpm run import:strava` / `pnpm run import:garmin`), run `pnpm run sync` to pull it from R2, " +
        "or set DB_PATH.",
    );
    return emptyFiles(stats);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT id,name,type,start_time,start_local,distance,moving_time,elapsed_time," +
          "elevation_gain,elevation_loss,avg_hr,max_hr,hr_zone_seconds," +
          "has_gps,has_hr,has_altitude,has_cadence,has_power,polyline,streams_sha256 " +
          "FROM activities WHERE visible = 1 ORDER BY start_time, id",
      )
      .all() as ActivityRow[];
    const sources = liveSources(db);
    const streams = db.prepare(`SELECT ${DETAIL_CHANNELS.join(",")} FROM streams WHERE file_sha256 = ?`);
    const files = emptyFiles(stats);
    const { file: places, placeOf, routeOf } = readPlaces(db);
    files.places = places;
    for (const row of rows) {
      if (!isUsable(row)) {
        warn(`Skipping activity ${row.id}: missing type or unparseable start_time.`);
        continue;
      }
      const route = wireRoute(row.polyline, stats);
      if (route) files.routes.routes[row.id] = route;
      const detail = readDetail(streams, row.streams_sha256);
      if (detail) {
        files.details.set(row.id, detail);
        const profile = routeProfile(detail);
        if (profile) files.profiles.profiles[row.id] = profile;
      }
      const groups = { place: placeOf.get(row.id), route: routeOf.get(row.id) };
      files.activities.activities.push(toRecord(row, sources.get(row.id) ?? [], detail != null, groups));
    }
    files.steps = readSteps(db);
    return files;
  } finally {
    db.close();
  }
}

/** Replace outDir with the display files. */
export async function writeDisplayFiles(files: DisplayFiles, outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "activity"), { recursive: true });
  await writeFile(join(outDir, "routes.json"), JSON.stringify(files.routes));
  await writeFile(join(outDir, "activities.json"), JSON.stringify(files.activities));
  await writeFile(join(outDir, "profiles.json"), JSON.stringify(files.profiles));
  await writeFile(join(outDir, "steps.json"), JSON.stringify(files.steps));
  await writeFile(join(outDir, "places.json"), JSON.stringify(files.places));
  for (const [id, detail] of files.details) {
    await writeFile(join(outDir, "activity", `${id}.json`), JSON.stringify(detail));
  }
}

async function main() {
  if (!process.env.DB_PATH && DB_PATH === DEMO_DB_PATH) {
    console.log(
      `No ${PERSONAL_DB_PATH}; building from the demo database. Import an export or ` +
        "run `pnpm run sync` to use your own data.",
    );
  }
  const files = readDisplayFiles(DB_PATH);
  await writeDisplayFiles(files, OUT_DIR);
  // The pre-Plan 4 tracks.json; a stale local copy would be bundled by Vite.
  await rm(LEGACY_TRACKS, { force: true });
  const { stats } = files;
  console.log(
    `Wrote ${Object.keys(files.routes.routes).length} routes, ${files.activities.activities.length} activities, ` +
      `${files.details.size} detail files, ${Object.keys(files.profiles.profiles).length} route profiles, ` +
      `${files.steps.steps.filter((s) => s != null).length} days of steps, ` +
      `${files.places.places.length} places, ${files.places.routes.length} same-route groups ` +
      `to ${OUT_DIR}; route points ${stats.rawPoints} -> ${stats.keptPoints} ` +
      `after ${SIMPLIFY_TOLERANCE_M}m simplify.`,
  );
}

// Only run when executed directly, so tests can import without I/O.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
