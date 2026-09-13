// Build app/public/tracks.json from the committed SQLite store.
// Reads activities with geometry, simplifies each route (Douglas–Peucker, 10 m)
// and re-encodes it as a Google polyline for the compact wire format. No network.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { EncodedTrack, TrackPayload } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, "../data/activities.sqlite");
const OUT_PATH = resolve(__dirname, "../app/public/tracks.json");

/** Wire-format version written to tracks.json (see TrackPayload). */
const PAYLOAD_VERSION = 2;
/** Douglas–Peucker tolerance (meters) applied to the stored line for the wire. */
const SIMPLIFY_TOLERANCE_M = Number(process.env.SIMPLIFY_TOLERANCE_M) || 10;

export interface ActivityRow {
  id: string;
  name: string;
  type: string;
  start_time: string;
  distance: number;
  moving_time: number;
  elevation_gain: number;
  polyline: string;
}

interface Stats {
  rawPoints: number;
  keptPoints: number;
}

function toTrack(a: ActivityRow, stats: Stats): EncodedTrack | null {
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
    distance: a.distance,
    moving_time: a.moving_time,
    elevation_gain: a.elevation_gain,
    poly,
  };
}

/** Pure: rows -> encoded tracks. Exported for tests. */
export function buildTracks(rows: ActivityRow[], stats: Stats): EncodedTrack[] {
  return rows.map((r) => toTrack(r, stats)).filter((t): t is EncodedTrack => t !== null);
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      "SELECT id,name,type,start_time,distance,moving_time,elevation_gain,polyline " +
        "FROM activities WHERE polyline <> '' ORDER BY start_time",
    )
    .all() as ActivityRow[];
  db.close();

  const stats: Stats = { rawPoints: 0, keptPoints: 0 };
  const tracks = buildTracks(rows, stats);
  const payload: TrackPayload = { v: PAYLOAD_VERSION, tracks };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));
  console.log(
    `Wrote ${tracks.length} route tracks; points ${stats.rawPoints} -> ${stats.keptPoints} ` +
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
