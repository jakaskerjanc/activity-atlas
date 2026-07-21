// Build app/public/activities.geojson from data/activities.json.
//
// Decodes each activity's route polyline into a LineString and attaches the
// filterable properties defined by ActivityFeatureProps. Prefers the
// full-resolution detail_polyline (simplified to an overview line) and falls
// back to the coarse summary_polyline. No API calls.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { CachedActivity, ActivityFeatureProps } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/activities.json");
const OUT_PATH = resolve(__dirname, "../app/public/activities.geojson");

/** Douglas–Peucker tolerance (meters) applied to detail polylines. */
const SIMPLIFY_TOLERANCE_M = Number(process.env.SIMPLIFY_TOLERANCE_M) || 5;

interface Feature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: ActivityFeatureProps;
}

interface Stats {
  rawPoints: number;
  keptPoints: number;
}

function toFeature(a: CachedActivity, stats: Stats): Feature | null {
  // Prefer full-resolution detail; fall back to the coarse summary line.
  const encoded = a.detail_polyline || a.summary_polyline;
  if (!encoded) return null; // indoor / manual — no route

  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  let coords = polyline
    .decode(encoded)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) return null;

  // Only the dense detail line needs thinning; the summary is already coarse.
  stats.rawPoints += coords.length;
  if (a.detail_polyline) coords = simplifyLngLat(coords, SIMPLIFY_TOLERANCE_M);
  stats.keptPoints += coords.length;

  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {
      id: a.id,
      name: a.name,
      type: a.type,
      ts: Math.floor(Date.parse(a.start_date) / 1000),
      start_date: a.start_date,
      distance: a.distance,
      moving_time: a.moving_time,
      elevation_gain: a.total_elevation_gain,
    },
  };
}

async function main() {
  const cache = JSON.parse(await readFile(CACHE_PATH, "utf8")) as CachedActivity[];
  const stats: Stats = { rawPoints: 0, keptPoints: 0 };
  const features = cache
    .map((a) => toFeature(a, stats))
    .filter((f): f is Feature => f !== null);

  const geojson = { type: "FeatureCollection" as const, features };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(geojson));
  const detailed = cache.filter((a) => a.detail_polyline).length;
  console.log(
    `Wrote ${features.length} route features (${cache.length - features.length} skipped, no route) to ${OUT_PATH}`,
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
