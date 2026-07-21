// Incremental sync: fetch new Strava activities into data/activities.json.
//
// Reads the committed cache, fetches only activities newer than the newest
// cached one (minus an overlap window to catch edits), merges by id, and
// writes the cache back sorted by start_date.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessToken, fetchActivitiesAfter } from "./strava.ts";
import type { CachedActivity } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/activities.json");

/** Re-fetch a window before the high-water mark so recent edits aren't missed. */
const OVERLAP_SECONDS = 24 * 60 * 60; // 1 day

async function loadCache(): Promise<CachedActivity[]> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8")) as CachedActivity[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function newestEpoch(activities: CachedActivity[]): number {
  let max = 0;
  for (const a of activities) {
    max = Math.max(max, Math.floor(Date.parse(a.start_date) / 1000));
  }
  return max;
}

async function main() {
  const cache = await loadCache();
  const highWater = newestEpoch(cache);
  const after = highWater > 0 ? Math.max(0, highWater - OVERLAP_SECONDS) : 0;

  console.log(
    cache.length === 0
      ? "Empty cache — full backfill."
      : `Cache has ${cache.length} activities; fetching after ${new Date(after * 1000).toISOString()}.`,
  );

  const token = await getAccessToken();
  const fetched = await fetchActivitiesAfter(token, after);
  console.log(`Fetched ${fetched.length} activities from Strava.`);

  // Merge by id (fetched overwrites stale cached copies).
  const byId = new Map<number, CachedActivity>();
  for (const a of cache) byId.set(a.id, a);
  for (const a of fetched) byId.set(a.id, a);

  const merged = [...byId.values()].sort(
    (a, b) => Date.parse(a.start_date) - Date.parse(b.start_date),
  );

  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(`Cache now holds ${merged.length} activities (+${merged.length - cache.length} new).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
