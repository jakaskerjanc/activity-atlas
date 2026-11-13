// Heart-rate zones for activities.json, recomputed from each activity's heart-rate
// stream against one set of limits (the reference limits), so zone time compares
// across the whole history. The database's stored zone seconds are not used: they
// were measured against limits that changed, and before the watch they were
// calculated from its factory defaults. See docs/2026-11-13-heart-rate-zones-design.md.

import type Database from "better-sqlite3";

/** A gap between samples longer than this is a pause: it counts in no zone. */
export const MAX_SAMPLE_GAP_S = 60;

/** Bands: below zone 1, then zones 1 to 5. */
export const ZONE_BANDS = 6;

const hasColumn = (db: Database.Database, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

/**
 * The lower bounds (bpm) of zones 1 to 5: the first five hr_zone_limits of the newest
 * visible activity whose zones its device reported (not calculated by ingest). Null
 * when no activity has reported zones (the demo database, a fork without a watch).
 */
export function referenceZoneLimits(db: Database.Database): number[] | null {
  if (!hasColumn(db, "activities", "hr_zone_limits") || !hasColumn(db, "activities", "calculated")) return null;
  const rows = db
    .prepare(
      "SELECT hr_zone_limits, calculated FROM activities " +
        "WHERE visible = 1 AND hr_zone_limits IS NOT NULL ORDER BY start_time DESC, id DESC",
    )
    .all() as { hr_zone_limits: string; calculated: string | null }[];
  for (const r of rows) {
    if (parseList(r.calculated).includes("hr_zone_seconds")) continue;
    const limits = parseList(r.hr_zone_limits);
    if (limits.length < 5 || !limits.every((v) => typeof v === "number" && v > 0)) continue;
    const bounds = (limits as number[]).slice(0, 5);
    if (bounds.every((v, i) => i === 0 || v > bounds[i - 1])) return bounds;
  }
  return null;
}

function parseList(text: string | null): unknown[] {
  if (text == null) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Seconds in each band (below zone 1, zones 1–5) from time and heart-rate samples.
 * Sample i lasts until sample i + 1; a gap over MAX_SAMPLE_GAP_S, a backward step or a
 * missing value on either channel counts nothing. Time above zone 5's top counts in
 * zone 5. Undefined when no time counts (no heart rate means unknown, not 0).
 */
export function zoneSeconds(
  time: readonly (number | null)[],
  hr: readonly (number | null)[],
  lowerBounds: readonly number[],
): number[] | undefined {
  const out = new Array<number>(ZONE_BANDS).fill(0);
  let counted = false;
  const n = Math.min(time.length, hr.length);
  for (let i = 0; i + 1 < n; i++) {
    const t0 = time[i];
    const t1 = time[i + 1];
    const h = hr[i];
    if (t0 == null || t1 == null || h == null || !(h > 0)) continue;
    const d = t1 - t0;
    if (!(d > 0) || d > MAX_SAMPLE_GAP_S) continue;
    let band = 0;
    while (band < lowerBounds.length && h >= lowerBounds[band]) band += 1;
    out[band] += d;
    counted = true;
  }
  const rounded = out.map((s) => Math.round(s));
  return counted && rounded.some((s) => s > 0) ? rounded : undefined;
}
