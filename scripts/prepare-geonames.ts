// Convert a downloaded GeoNames cities15000.txt into the vendored, pre-filtered
// build input scripts/data/geonames-cities.json. Rare manual step:
//
//   curl -L -o /tmp/cities15000.zip https://download.geonames.org/export/dump/cities15000.zip
//   unzip -o /tmp/cities15000.zip -d /tmp
//   pnpm exec tsx scripts/prepare-geonames.ts /tmp/cities15000.txt
//
// Keeps only rows stage A could select (in bucket range, above the
// distance-scaled population floor, not a city district), with just the seven
// fields it needs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, bucketIndex, haversineM, popFloor } from "./build-city-distances.ts";
import type { GeoCity, LatLon } from "./city-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "data/geonames-cities.json");

/** One cities15000.txt row → GeoCity, or null for blank / malformed rows. */
export function parseGeonamesLine(line: string): GeoCity | null {
  const f = line.split("\t");
  if (f.length < 15) return null;
  const id = Number(f[0]);
  const lat = Number(f[4]);
  const lon = Number(f[5]);
  const population = Number(f[14]);
  if (![id, lat, lon, population].every(Number.isFinite)) return null;
  return { id, name: f[1], country: f[8], lat, lon, population, fc: f[7] };
}

/** GeoNames codes that aren't a recognizable city: city districts, historical, abandoned. */
const EXCLUDED_FC = new Set(["PPLX", "PPLH", "PPLQ"]);

/** Rows stage A could ever select, sorted by id for stable diffs. */
export function prefilter(cities: GeoCity[], origin: LatLon = ORIGIN): GeoCity[] {
  return cities
    .filter((c) => {
      if (EXCLUDED_FC.has(c.fc)) return false;
      const d = haversineM(origin, c);
      return bucketIndex(d) !== null && c.population >= popFloor(d);
    })
    .sort((a, b) => a.id - b.id);
}

/** JSON array with one city per line, so regenerations diff readably. */
export function serializeCities(cities: GeoCity[]): string {
  return `[\n${cities.map((c) => JSON.stringify(c)).join(",\n")}\n]`;
}

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error("usage: tsx scripts/prepare-geonames.ts <cities15000.txt>");
  const rows = (await readFile(src, "utf8"))
    .split("\n")
    .map(parseGeonamesLine)
    .filter((c): c is GeoCity => c !== null);
  const kept = prefilter(rows);
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, serializeCities(kept) + "\n");
  console.log(`Kept ${kept.length} of ${rows.length} GeoNames rows → ${OUT_PATH}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
