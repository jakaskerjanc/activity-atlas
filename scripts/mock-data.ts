// Generate mock activities with realistic GPS tracks for UI testing.
//
//   npm run mock            # ~48 activities
//   npm run mock -- 120     # custom count
//
// Overwrites data/activities.json with generated data. Reset it to `[]` before
// connecting real Strava, or the mock activities will persist in the cache.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import polyline from "@mapbox/polyline";
import type { CachedActivity } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/activities.json");

/** Seeded RNG (mulberry32) so regeneration is stable. */
function makeRng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Place {
  name: string;
  lat: number;
  lng: number;
}
const PLACES: Place[] = [
  { name: "Ljubljana", lat: 46.056, lng: 14.508 },
  { name: "Bled", lat: 46.369, lng: 14.114 },
  { name: "Trieste", lat: 45.649, lng: 13.776 },
  { name: "Zurich", lat: 47.377, lng: 8.541 },
  { name: "Chamonix", lat: 45.923, lng: 6.87 },
];

interface Kind {
  type: string;
  minKm: number;
  maxKm: number;
  paceSecPerKm: number; // rough moving pace
  climbPerKm: number; // meters of gain per km
}
const KINDS: Kind[] = [
  { type: "Run", minKm: 5, maxKm: 15, paceSecPerKm: 300, climbPerKm: 8 },
  { type: "TrailRun", minKm: 8, maxKm: 25, paceSecPerKm: 380, climbPerKm: 45 },
  { type: "Ride", minKm: 20, maxKm: 90, paceSecPerKm: 130, climbPerKm: 12 },
  { type: "Hike", minKm: 6, maxKm: 20, paceSecPerKm: 720, climbPerKm: 90 },
  { type: "Walk", minKm: 2, maxKm: 7, paceSecPerKm: 800, climbPerKm: 4 },
];

const M_PER_DEG_LAT = 111_320;

/**
 * Random walk from a place center that gently drifts and loops back toward the
 * start, producing a route-like LineString. Returns [lat, lng] points.
 */
function makeTrack(
  place: Place,
  distanceKm: number,
  rng: () => number,
): [number, number][] {
  const points = Math.max(20, Math.round(distanceKm * 12));
  const stepM = (distanceKm * 1000) / points;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((place.lat * Math.PI) / 180);

  // Start slightly offset from the place center so tracks don't all stack.
  let lat = place.lat + (rng() - 0.5) * 0.02;
  let lng = place.lng + (rng() - 0.5) * 0.02;
  const startLat = lat;
  const startLng = lng;
  let heading = rng() * 2 * Math.PI;

  const coords: [number, number][] = [[lat, lng]];
  for (let i = 1; i < points; i++) {
    // Wander, and in the back half steer back toward start to close the loop.
    heading += (rng() - 0.5) * 0.8;
    if (i > points / 2) {
      const back = Math.atan2(startLat - lat, startLng - lng);
      heading = heading * 0.85 + back * 0.15;
    }
    lat += (Math.sin(heading) * stepM) / M_PER_DEG_LAT;
    lng += (Math.cos(heading) * stepM) / mPerDegLng;
    coords.push([Number(lat.toFixed(5)), Number(lng.toFixed(5))]);
  }
  return coords;
}

function main() {
  const count = Number(process.argv[2]) || 48;
  const rng = makeRng(42);
  const now = Date.now();
  const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

  const activities: CachedActivity[] = [];
  for (let i = 0; i < count; i++) {
    const place = PLACES[Math.floor(rng() * PLACES.length)];
    const kind = KINDS[Math.floor(rng() * KINDS.length)];
    const distanceKm = kind.minKm + rng() * (kind.maxKm - kind.minKm);

    const track = makeTrack(place, distanceKm, rng);
    const start = new Date(now - rng() * TWO_YEARS_MS);
    const jitter = 0.85 + rng() * 0.3;

    activities.push({
      id: 900_000_000 + i, // clearly-fake id range
      name: `${place.name} ${kind.type}`,
      type: kind.type,
      start_date: start.toISOString(),
      distance: Math.round(distanceKm * 1000),
      moving_time: Math.round(distanceKm * kind.paceSecPerKm * jitter),
      total_elevation_gain: Math.round(distanceKm * kind.climbPerKm * jitter),
      summary_polyline: polyline.encode(track),
    });
  }

  activities.sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
  return activities;
}

const activities = main();
await mkdir(dirname(CACHE_PATH), { recursive: true });
await writeFile(CACHE_PATH, JSON.stringify(activities, null, 2) + "\n");
console.log(
  `Wrote ${activities.length} mock activities to data/activities.json.\n` +
    `Run: npm run build:geojson   (then start the app)\n` +
    `Reset to [] before connecting real Strava.`,
);
