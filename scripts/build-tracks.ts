// Build the display files in app/public/data/ from the SQLite database at
// DB_PATH (default data/activities.sqlite, synced from R2). See
// docs/2026-11-04-display-files-design.md. No network.
//
//   routes.json         v4  route polylines keyed by activity id (10 m Douglas–Peucker)
//   activities.json     v1  every visible activity's numbers; unknown values left out
//   activity/<id>.json  v1  downsampled samples, loaded when an activity is opened
//
// Hidden and deleted activities never reach these files, and the folder is
// emptied before each write so a stale file cannot survive.

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import { toRecord, type ActivityRow } from "./numbers.ts";
import type {
  ActivitiesFile,
  ActivityRecord,
  ActivitySource,
  DetailFile,
  EncodedTrack,
  RoutesFile,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, "../data/activities.sqlite");
export const OUT_DIR = resolve(__dirname, "../app/public/data");
const LEGACY_TRACKS = resolve(__dirname, "../app/public/tracks.json");

export const ROUTES_VERSION = 4;
export const ACTIVITIES_VERSION = 1;
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

function emptyFiles(stats: Stats): DisplayFiles {
  return {
    routes: { v: ROUTES_VERSION, routes: {} },
    activities: { v: ACTIVITIES_VERSION, activities: [] },
    details: new Map(),
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
    warn(`No database at ${dbPath}; writing empty display files. Run \`pnpm sync\` to pull it from R2.`);
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
    const files = emptyFiles(stats);
    for (const row of rows) {
      const route = wireRoute(row.polyline, stats);
      if (route) files.routes.routes[row.id] = route;
      files.activities.activities.push(toRecord(row, sources.get(row.id) ?? [], false));
    }
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
  for (const [id, detail] of files.details) {
    await writeFile(join(outDir, "activity", `${id}.json`), JSON.stringify(detail));
  }
}

/** v3 bridge for the app until it reads the new files. TODO(Plan 4 Task 3): remove. */
function legacyTracks(files: DisplayFiles): { v: 3; tracks: EncodedTrack[] } {
  const tracks: EncodedTrack[] = [];
  for (const a of files.activities.activities as ActivityRecord[]) {
    const poly = files.routes.routes[a.id];
    if (!poly) continue;
    tracks.push({
      id: a.id, name: a.name, type: a.type, ts: a.ts, start_date: a.start_date,
      distance: a.distance ?? 0, moving_time: a.moving_time ?? 0, elevation_gain: a.elevation_gain ?? 0,
      sources: a.sources, poly,
    });
  }
  return { v: 3, tracks };
}

async function main() {
  const files = readDisplayFiles(DB_PATH);
  await writeDisplayFiles(files, OUT_DIR);
  await writeFile(LEGACY_TRACKS, JSON.stringify(legacyTracks(files)));
  const { stats } = files;
  console.log(
    `Wrote ${Object.keys(files.routes.routes).length} routes, ${files.activities.activities.length} activities, ` +
      `${files.details.size} detail files to ${OUT_DIR}; route points ${stats.rawPoints} -> ${stats.keptPoints} ` +
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
