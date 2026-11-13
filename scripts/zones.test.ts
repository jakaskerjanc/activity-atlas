import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MAX_SAMPLE_GAP_S, referenceZoneLimits, zoneSeconds } from "./zones.ts";
import { addActivity, withDb } from "./testDb.ts";

const BOUNDS = [100, 120, 140, 160, 180];

test("each sample lasts until the next and lands in its band", () => {
  // 95 below zone 1, 100 zone 1 (a bound starts its zone), 139 zone 2, 165 zone 4, 210 zone 5.
  assert.deepEqual(zoneSeconds([0, 2, 5, 6, 10, 11], [95, 100, 139, 165, 210, 210], BOUNDS), [2, 3, 1, 0, 4, 1]);
});

test("pauses, backward steps and missing samples count nothing", () => {
  const gap = MAX_SAMPLE_GAP_S + 1;
  assert.deepEqual(
    zoneSeconds([0, 10, 10 + gap, 5, 20, null, 30], [130, 130, 130, null, 130, 130, 130], BOUNDS),
    [0, 0, 10, 0, 0, 0],
  );
  // A gap of exactly the limit still counts.
  assert.deepEqual(zoneSeconds([0, MAX_SAMPLE_GAP_S], [150, 150], BOUNDS), [0, 0, 0, MAX_SAMPLE_GAP_S, 0, 0]);
});

test("no counted time is unknown, not zeros", () => {
  assert.equal(zoneSeconds([0, 1, 2], [null, null, null], BOUNDS), undefined);
  assert.equal(zoneSeconds([0], [140], BOUNDS), undefined);
  assert.equal(zoneSeconds([], [], BOUNDS), undefined);
});

function limitsOf(setup: (db: Database.Database) => void): number[] | null {
  let out: number[] | null = null;
  withDb(setup, (path) => {
    const db = new Database(path, { readonly: true });
    out = referenceZoneLimits(db);
    db.close();
  });
  return out;
}

test("reference limits: the newest visible activity with zones its watch reported", () => {
  const limits = limitsOf((db) => {
    addActivity(db, "old", { start_time: "2026-01-01T00:00:00+00:00", hr_zone_limits: "[98,118,137,157,176,196]" });
    addActivity(db, "new", { start_time: "2026-09-01T00:00:00+00:00", hr_zone_limits: "[100,119,139,159,179,199]" });
    // Newer, but its zones were calculated by ingest from borrowed limits.
    addActivity(db, "calc", {
      start_time: "2026-10-01T00:00:00+00:00",
      hr_zone_limits: "[128,153,179,204,230]",
      calculated: '["hr_zone_seconds"]',
    });
    addActivity(db, "hidden", { start_time: "2026-11-01T00:00:00+00:00", hr_zone_limits: "[1,2,3,4,5,6]", visible: 0 });
  });
  assert.deepEqual(limits, [100, 119, 139, 159, 179]);
});

test("reference limits: none without reported zones, and none from malformed limits", () => {
  assert.equal(limitsOf((db) => addActivity(db, "a")), null);
  assert.equal(limitsOf((db) => addActivity(db, "a", { hr_zone_limits: "[100,90,140,160,180]" })), null);
  assert.equal(limitsOf((db) => addActivity(db, "a", { hr_zone_limits: "not json" })), null);
  assert.equal(limitsOf((db) => addActivity(db, "a", { hr_zone_limits: "[100,120]" })), null);
});
