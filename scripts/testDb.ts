// Test helpers: a throwaway v5 database holding the tables and columns the
// display build reads (a subset of ingest/db.py's schema). Not used by the build.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { CHANNEL_SCALES, type StreamChannel } from "./codec.ts";

export const POLY = polyline.encode([[46.0, 14.0], [46.001, 14.001], [46.002, 14.0]]);

const STREAM_COLS = Object.keys(CHANNEL_SCALES).map((c) => `${c} BLOB`).join(", ");

/** The place and same-route tables (schema v5); an older database has none. */
const GROUP_TABLES = `
  CREATE TABLE places (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_source TEXT NOT NULL,
    kind TEXT NOT NULL, ele REAL NOT NULL
  );
  CREATE TABLE route_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_source TEXT NOT NULL);
  CREATE TABLE activity_groups (activity_id TEXT PRIMARY KEY, place_id TEXT, route_id TEXT);
`;

export function withDb(
  setup: (db: Database.Database) => void,
  run: (path: string) => void,
  { withoutGroupTables = false }: { withoutGroupTables?: boolean } = {},
) {
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
  if (!withoutGroupTables) db.exec(GROUP_TABLES);
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

export function addPlace(
  db: Database.Database,
  id: string,
  name: string,
  kind: "peak" | "pass" | "top" = "peak",
  ele = 1000,
) {
  db.prepare("INSERT INTO places (id, name, name_source, kind, ele) VALUES (?, ?, 'osm', ?, ?)").run(
    id,
    name,
    kind,
    ele,
  );
}

export function addRouteGroup(db: Database.Database, id: string, name: string) {
  db.prepare("INSERT INTO route_groups (id, name, name_source) VALUES (?, ?, 'activity_names')").run(id, name);
}

/** An activity_groups row: the activity's place and same-route group ids, either NULL. */
export function addActivityGroup(
  db: Database.Database,
  activityId: string,
  placeId: string | null,
  routeId: string | null,
) {
  db.prepare("INSERT INTO activity_groups (activity_id, place_id, route_id) VALUES (?, ?, ?)").run(
    activityId,
    placeId,
    routeId,
  );
}

/**
 * Port of ingest/codec.py encode, for building streams rows in tests only.
 * codec.test.ts checks it round-trips through decodeChannel on every fixture case.
 */
export function encodeChannel(channel: StreamChannel, values: (number | null)[]): Buffer {
  const scale = CHANNEL_SCALES[channel];
  const buf = Buffer.alloc(values.length * 8);
  let prev = 0n;
  values.forEach((v, i) => {
    if (v == null) {
      buf.writeBigInt64LE(-(2n ** 63n), i * 8);
      return;
    }
    const q = BigInt(Math.round(v * scale));
    buf.writeBigInt64LE(q - prev, i * 8);
    prev = q;
  });
  return deflateSync(buf, { level: 9 });
}

/** Insert a streams row; channels not given stay NULL. */
export function addStreams(
  db: Database.Database,
  sha: string,
  channels: Partial<Record<StreamChannel, (number | null)[]>>,
) {
  const cols = Object.keys(channels) as StreamChannel[];
  const n = channels.time?.length ?? 0;
  db.prepare(
    `INSERT INTO streams (file_sha256, sample_count, encoding${cols.map((c) => "," + c).join("")}) ` +
      `VALUES (?, ?, 1${cols.map(() => ",?").join("")})`,
  ).run(sha, n, ...cols.map((c) => encodeChannel(c, channels[c]!)));
}

/** A daily_stats row (created on first use, as the demo database has none), with a raw blob. */
export function addDailyStats(db: Database.Database, date: string, steps: number | null) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY, resting_hr REAL, sleep_s REAL, steps INTEGER, weight_kg REAL, raw TEXT
  )`);
  db.prepare(
    "INSERT INTO daily_stats (date, resting_hr, sleep_s, steps, weight_kg, raw) VALUES (?, 52, 28000, ?, 70, ?)",
  ).run(date, steps, JSON.stringify({ steps: [{ stepGoal: 10000, totalSteps: steps }] }));
}
