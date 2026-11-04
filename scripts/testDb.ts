// Test helpers: a throwaway v2 database holding the tables and columns the
// display build reads (a subset of ingest/db.py's schema). Not used by the build.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { CHANNEL_SCALES, type StreamChannel } from "./codec.ts";

export const POLY = polyline.encode([[46.0, 14.0], [46.001, 14.001], [46.002, 14.0]]);

const STREAM_COLS = Object.keys(CHANNEL_SCALES).map((c) => `${c} BLOB`).join(", ");

export function withDb(setup: (db: Database.Database) => void, run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "build-tracks-"));
  const path = join(dir, "activities.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, name TEXT, type TEXT, start_time TEXT, start_local TEXT,
      elapsed_time REAL, moving_time REAL, distance REAL,
      elevation_gain REAL, elevation_loss REAL, avg_hr REAL, max_hr REAL,
      hr_zone_seconds TEXT, polyline TEXT NOT NULL DEFAULT '',
      has_gps INTEGER NOT NULL DEFAULT 0, has_hr INTEGER NOT NULL DEFAULT 0,
      has_altitude INTEGER NOT NULL DEFAULT 0, has_cadence INTEGER NOT NULL DEFAULT 0,
      has_power INTEGER NOT NULL DEFAULT 0, streams_sha256 TEXT,
      visible INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE activity_sources (
      provider TEXT NOT NULL, provider_activity_id TEXT NOT NULL,
      activity_id TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY (provider, provider_activity_id)
    );
    CREATE TABLE streams (
      file_sha256 TEXT PRIMARY KEY, sample_count INTEGER NOT NULL, encoding INTEGER NOT NULL,
      ${STREAM_COLS}
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

export function addActivity(db: Database.Database, id: string, over: Record<string, unknown> = {}) {
  const a: Record<string, unknown> = {
    id,
    name: "Run",
    type: "Run",
    start_time: "2026-08-01T06:30:00+00:00",
    start_local: "2026-08-01T08:30:00",
    elapsed_time: 700,
    moving_time: 600,
    distance: 1000,
    elevation_gain: 10,
    elevation_loss: 9,
    avg_hr: 140,
    max_hr: 170,
    hr_zone_seconds: "[10,20,30,40,50,60]",
    polyline: POLY,
    has_gps: 1,
    has_hr: 1,
    has_altitude: 1,
    has_cadence: 0,
    has_power: 0,
    streams_sha256: null,
    visible: 1,
    ...over,
  };
  const cols = Object.keys(a);
  db.prepare(
    `INSERT INTO activities (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`,
  ).run(a);
}

export function addSource(
  db: Database.Database,
  activityId: string,
  provider: string,
  pid: string,
  deletedAt: string | null = null,
) {
  db.prepare(
    "INSERT INTO activity_sources (provider,provider_activity_id,activity_id,deleted_at) VALUES (?,?,?,?)",
  ).run(provider, pid, activityId, deletedAt);
}

export type { StreamChannel };
