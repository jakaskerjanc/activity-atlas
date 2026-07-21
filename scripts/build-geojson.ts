// Build app/public/activities.geojson from data/activities.json.
//
// Decodes each activity's summary polyline into a LineString and attaches the
// filterable properties defined by ActivityFeatureProps. No API calls.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import type { CachedActivity, ActivityFeatureProps } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/activities.json");
const OUT_PATH = resolve(__dirname, "../app/public/activities.geojson");

interface Feature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: ActivityFeatureProps;
}

function toFeature(a: CachedActivity): Feature | null {
  if (!a.summary_polyline) return null; // indoor / manual — no route
  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  const coords = polyline
    .decode(a.summary_polyline)
    .map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) return null;

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
  const features = cache
    .map(toFeature)
    .filter((f): f is Feature => f !== null);

  const geojson = { type: "FeatureCollection" as const, features };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(geojson));
  console.log(
    `Wrote ${features.length} route features (${cache.length - features.length} skipped, no route) to ${OUT_PATH}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
