// Build app/public/tracks.json from the SQLite database at DB_PATH (default data/activities.sqlite, synced from R2).
// Reads visible activities with geometry from the v2 database (hidden and
// deleted ones never reach the public site), simplifies each route (Douglas–Peucker, 10 m)
// and re-encodes it as a Google polyline for the compact wire format. No network.

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { EncodedTrack, TrackPayload, ActivitySource } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, "../data/activities.sqlite");
const OUT_PATH = resolve(__dirname, "../app/public/tracks.json");

/** Wire-format version written to tracks.json (see TrackPayload). */
const PAYLOAD_VERSION = 3;
/** Douglas–Peucker tolerance (meters) applied to the stored line for the wire. */
const SIMPLIFY_TOLERANCE_M = Number(process.env.SIMPLIFY_TOLERANCE_M) || 10;

export interface ActivityRow {
  id: string;
  name: string;
  type: string;
  start_time: string;
  // v2 numbers can be NULL (unknown), unlike v1 which stored 0.
  distance: number | null;
  moving_time: number | null;
  elevation_gain: number | null;
  polyline: string;
}

interface Stats {
  rawPoints: number;
  keptPoints: number;
}

function toTrack(a: ActivityRow, stats: Stats, sources: ActivitySource[]): EncodedTrack | null {
  if (!a.polyline) return null; // indoor / manual — no route
  let coords = polyline.decode(a.polyline).map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) return null;
  stats.rawPoints += coords.length;
  coords = simplifyLngLat(coords, SIMPLIFY_TOLERANCE_M);
  stats.keptPoints += coords.length;
  const poly = polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    ts: Math.floor(Date.parse(a.start_time) / 1000),
    start_date: a.start_time,
    // v1 display behaviour; Plan 4's display files keep NULL absent
    distance: a.distance ?? 0,
    moving_time: a.moving_time ?? 0,
    elevation_gain: a.elevation_gain ?? 0,
    sources,
    poly,
  };
}

/** Pure: rows -> encoded tracks. Exported for tests. */
export function buildTracks(
  rows: ActivityRow[],
  stats: Stats,
  sourcesById: Map<string, ActivitySource[]> = new Map(),
): EncodedTrack[] {
  return rows
    .map((r) => toTrack(r, stats, sourcesById.get(r.id) ?? []))
    .filter((t): t is EncodedTrack => t !== null);
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
    if (!provider) continue; // wire format only knows strava and garmin
    const list = byId.get(r.activity_id) ?? [];
    list.push({ provider, id: r.provider_activity_id });
    byId.set(r.activity_id, list);
  }
  for (const list of byId.values()) {
    list.sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
  }
  return byId;
}

/**
 * Query the database and encode the visible routes. A missing database (a fork
 * with neither R2 nor a demo database) yields an empty payload and a warning.
 */
export function readPayload(
  dbPath: string,
  warn: (message: string) => void = console.warn,
): { payload: TrackPayload; stats: Stats } {
  const stats: Stats = { rawPoints: 0, keptPoints: 0 };
  if (!existsSync(dbPath)) {
    warn(`No database at ${dbPath}; writing an empty track list. Run \`npm run sync\` to pull it from R2.`);
    return { payload: { v: PAYLOAD_VERSION, tracks: [] }, stats };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT id,name,type,start_time,distance,moving_time,elevation_gain,polyline " +
          "FROM activities WHERE visible = 1 AND polyline <> '' ORDER BY start_time",
      )
      .all() as ActivityRow[];
    const tracks = buildTracks(rows, stats, liveSources(db));
    return { payload: { v: PAYLOAD_VERSION, tracks }, stats };
  } finally {
    db.close();
  }
}

async function main() {
  const { payload, stats } = readPayload(DB_PATH);
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));
  console.log(
    `Wrote ${payload.tracks.length} route tracks; points ${stats.rawPoints} -> ${stats.keptPoints} ` +
      `after ${SIMPLIFY_TOLERANCE_M}m simplify.`,
  );
}

// Only run when executed directly, so tests can import buildTracks without I/O.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
