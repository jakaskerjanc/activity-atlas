// Build app/public/tracks.json from data/activities.json.
//
// Decodes each activity's route polyline, simplifies the full-resolution detail
// line (Douglas–Peucker), and RE-ENCODES it as a Google polyline. Shipping
// encoded polylines instead of decoded GeoJSON coordinate arrays roughly halves
// the payload and makes the browser's JSON.parse far cheaper; the frontend
// decodes them back into LineString features (see app/src/tracks.ts). No API calls.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { CachedActivity, EncodedTrack, TrackPayload } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/activities.json");
const OUT_PATH = resolve(__dirname, "../app/public/tracks.json");

/** Wire-format version written to tracks.json (see TrackPayload). */
const PAYLOAD_VERSION = 1;

/** Douglas–Peucker tolerance (meters) applied to detail polylines. */
const SIMPLIFY_TOLERANCE_M = Number(process.env.SIMPLIFY_TOLERANCE_M) || 5;

interface Stats {
  rawPoints: number;
  keptPoints: number;
}

function toTrack(a: CachedActivity, stats: Stats): EncodedTrack | null {
  // Prefer full-resolution detail; fall back to the coarse summary line.
  const encoded = a.detail_polyline || a.summary_polyline;
  if (!encoded) return null; // indoor / manual — no route

  // @mapbox/polyline decodes to [lat, lng]; simplify works in [lng, lat].
  let coords = polyline
    .decode(encoded)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) return null;

  // Only the dense detail line needs thinning; the summary is already coarse.
  stats.rawPoints += coords.length;
  if (a.detail_polyline) coords = simplifyLngLat(coords, SIMPLIFY_TOLERANCE_M);
  stats.keptPoints += coords.length;

  // Re-encode back to [lat, lng] for the compact wire format.
  const poly = polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));

  return {
    id: a.id,
    name: a.name,
    type: a.type,
    ts: Math.floor(Date.parse(a.start_date) / 1000),
    start_date: a.start_date,
    distance: a.distance,
    moving_time: a.moving_time,
    elevation_gain: a.total_elevation_gain,
    poly,
  };
}

async function main() {
  const cache = JSON.parse(await readFile(CACHE_PATH, "utf8")) as CachedActivity[];
  const stats: Stats = { rawPoints: 0, keptPoints: 0 };
  const tracks = cache
    .map((a) => toTrack(a, stats))
    .filter((t): t is EncodedTrack => t !== null);

  const payload: TrackPayload = { v: PAYLOAD_VERSION, tracks };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));
  const detailed = cache.filter((a) => a.detail_polyline).length;
  console.log(
    `Wrote ${tracks.length} route tracks (${cache.length - tracks.length} skipped, no route) to ${OUT_PATH}`,
  );
  console.log(
    `Points: ${stats.rawPoints} -> ${stats.keptPoints} after simplify ` +
      `(${detailed}/${cache.length} detailed, tolerance ${SIMPLIFY_TOLERANCE_M}m).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
