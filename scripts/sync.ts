// Incremental sync: fetch new Strava activities into data/activities.json.
//
// Reads the committed cache, fetches only activities newer than the newest
// cached one (minus an overlap window to catch edits), merges by id, and
// writes the cache back sorted by start_date.

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAccessToken, fetchActivitiesAfter, fetchActivityDetail } from "./strava.ts";
import type { CachedActivity } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, "../data/activities.json");

/** Re-fetch a window before the high-water mark so recent edits aren't missed. */
const OVERLAP_SECONDS = 24 * 60 * 60; // 1 day

/**
 * Max detail-endpoint requests per run. Default keeps a single run under the
 * 200 req / 15 min read limit; the initial backfill just runs a few times.
 */
const DETAIL_LIMIT = Number(process.env.DETAIL_LIMIT) || 190;

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

  // Merge by id (fetched overwrites stale cached copies). Fetched summaries carry
  // no detail_polyline, so carry over the cached one when the route is unchanged —
  // otherwise the overlap window would re-detail recent activities every run. A
  // changed summary_polyline means the route was edited, so drop the stale detail.
  const byId = new Map<number, CachedActivity>();
  for (const a of cache) byId.set(a.id, a);
  for (const a of fetched) {
    const prev = byId.get(a.id);
    if (prev?.detail_polyline && prev.summary_polyline === a.summary_polyline) {
      a.detail_polyline = prev.detail_polyline;
    }
    byId.set(a.id, a);
  }

  const merged = [...byId.values()].sort(
    (a, b) => Date.parse(a.start_date) - Date.parse(b.start_date),
  );

  // Detail pass: backfill full-resolution polylines for activities that have a
  // route but no detail yet, newest first, capped per run. Incremental — steady
  // state only touches the handful of new activities.
  const pending = merged
    .filter((a) => a.summary_polyline && a.detail_polyline === undefined)
    .reverse();
  const toDetail = pending.slice(0, DETAIL_LIMIT);
  if (pending.length > 0) {
    console.log(`Detailing ${toDetail.length} of ${pending.length} pending...`);
    for (const a of toDetail) {
      a.detail_polyline = await fetchActivityDetail(token, a.id);
    }
    console.log(`Detailed ${toDetail.length} (${pending.length - toDetail.length} remaining).`);
  }

  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(merged, null, 2) + "\n");
  const newCount = merged.length - cache.length;
  console.log(`Cache now holds ${merged.length} activities (+${newCount} new).`);

  // Surface the count to the calling workflow (e.g. for the commit message).
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `new_count=${newCount}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
