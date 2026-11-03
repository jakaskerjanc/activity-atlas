import { test } from "node:test";
import assert from "node:assert/strict";
import polyline from "@mapbox/polyline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildTracks, readPayload, type ActivityRow } from "./build-tracks.ts";

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "abc123", name: "Run", type: "Run", start_time: "2026-08-01T06:30:00+00:00",
    distance: 1000, moving_time: 600, elevation_gain: 10,
    polyline: polyline.encode([[46.0, 14.0], [46.001, 14.001], [46.002, 14.0]]),
    ...over,
  } as ActivityRow;
}

test("builds an encoded track with id", () => {
  const stats = { rawPoints: 0, keptPoints: 0 };
  const out = buildTracks([row()], stats);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "abc123");
  assert.equal(out[0].elevation_gain, 10);
  assert.ok(out[0].poly.length > 0);
});

test("skips rows with no polyline", () => {
  const out = buildTracks([row({ id: "g1", polyline: "" })], { rawPoints: 0, keptPoints: 0 });
  assert.equal(out.length, 0);
});

// --- v2 database bridge -----------------------------------------------------

const POLY = polyline.encode([[46.0, 14.0], [46.001, 14.001], [46.002, 14.0]]);

/** A throwaway v2 database holding just the columns the display bridge reads. */
function withDb(setup: (db: Database.Database) => void, run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "build-tracks-"));
  const path = join(dir, "activities.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, name TEXT, type TEXT, start_time TEXT,
      moving_time REAL, distance REAL, elevation_gain REAL,
      polyline TEXT NOT NULL DEFAULT '', visible INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE activity_sources (
      provider TEXT NOT NULL, provider_activity_id TEXT NOT NULL,
      activity_id TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY (provider, provider_activity_id)
    );
  `);
  try {
    setup(db);
    db.close();
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function addActivity(db: Database.Database, id: string, over: Record<string, unknown> = {}) {
  const a = {
    name: "Run", type: "Run", start_time: "2026-08-01T06:30:00+00:00",
    moving_time: 600, distance: 1000, elevation_gain: 10, polyline: POLY, visible: 1,
    ...over,
  };
  db.prepare(
    "INSERT INTO activities (id,name,type,start_time,moving_time,distance,elevation_gain,polyline,visible) " +
      "VALUES (@id,@name,@type,@start_time,@moving_time,@distance,@elevation_gain,@polyline,@visible)",
  ).run({ id, ...a });
}

function addSource(db: Database.Database, activityId: string, provider: string, pid: string, deletedAt: string | null = null) {
  db.prepare(
    "INSERT INTO activity_sources (provider,provider_activity_id,activity_id,deleted_at) VALUES (?,?,?,?)",
  ).run(provider, pid, activityId, deletedAt);
}

test("drops invisible activities", () => {
  withDb(
    (db) => {
      addActivity(db, "aaa");
      addActivity(db, "hidden", { visible: 0 });
      addActivity(db, "nopoly", { polyline: "" });
    },
    (path) => {
      const { payload } = readPayload(path);
      assert.deepEqual(payload.tracks.map((t) => t.id), ["aaa"]);
    },
  );
});

test("sources lists live providers strava first", () => {
  withDb(
    (db) => {
      addActivity(db, "merged");
      addSource(db, "merged", "garmin", "100");
      addSource(db, "merged", "strava", "999");
    },
    (path) => {
      const { payload } = readPayload(path);
      assert.deepEqual(payload.tracks[0].sources, [
        { provider: "strava", id: "999" },
        { provider: "garmin", id: "100" },
      ]);
    },
  );
  withDb(
    (db) => {
      addActivity(db, "merged");
      addSource(db, "merged", "garmin", "222", "2026-09-01T00:00:00Z");
      addSource(db, "merged", "strava", "111");
    },
    (path) => {
      const { payload } = readPayload(path);
      assert.deepEqual(payload.tracks[0].sources, [{ provider: "strava", id: "111" }]);
    },
  );
});

test("null numbers become 0, as v1 displayed them", () => {
  withDb(
    (db) => addActivity(db, "a", { distance: null, moving_time: null, elevation_gain: null }),
    (path) => {
      const t = readPayload(path).payload.tracks[0];
      assert.deepEqual([t.distance, t.moving_time, t.elevation_gain], [0, 0, 0]);
    },
  );
});

test("missing database writes an empty payload", () => {
  const warnings: string[] = [];
  const { payload } = readPayload("/nonexistent/dir/activities.sqlite", (m) => warnings.push(m));
  assert.deepEqual(payload, { v: 3, tracks: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sync/);
});
