import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDisplayFiles, writeDisplayFiles } from "./build-tracks.ts";
import { addActivity, addSource, withDb } from "./testDb.ts";

test("routes keyed by id for visible routed activities", () => {
  withDb(
    (db) => addActivity(db, "aaa"),
    (path) => {
      const { routes } = readDisplayFiles(path);
      assert.equal(routes.v, 4);
      assert.deepEqual(Object.keys(routes.routes), ["aaa"]);
      assert.ok(routes.routes.aaa.length > 0);
    },
  );
});

test("route-less activity is in activities, not routes", () => {
  withDb(
    (db) => addActivity(db, "gym", { polyline: "", has_gps: 0, distance: 0 }),
    (path) => {
      const { routes, activities } = readDisplayFiles(path);
      assert.deepEqual(routes.routes, {});
      assert.deepEqual(activities.activities.map((a) => a.id), ["gym"]);
      assert.ok(!("distance" in activities.activities[0]));
    },
  );
});

test("hidden activity is absent from both files", () => {
  withDb(
    (db) => {
      addActivity(db, "aaa");
      addActivity(db, "hidden", { visible: 0 });
    },
    (path) => {
      const { routes, activities } = readDisplayFiles(path);
      assert.deepEqual(Object.keys(routes.routes), ["aaa"]);
      assert.deepEqual(activities.activities.map((a) => a.id), ["aaa"]);
    },
  );
});

test("sources list live providers strava first", () => {
  withDb(
    (db) => {
      addActivity(db, "merged");
      addSource(db, "merged", "garmin", "100");
      addSource(db, "merged", "strava", "999");
    },
    (path) => {
      assert.deepEqual(readDisplayFiles(path).activities.activities[0].sources, [
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
      assert.deepEqual(readDisplayFiles(path).activities.activities[0].sources, [
        { provider: "strava", id: "111" },
      ]);
    },
  );
});

test("activities sorted by start then id", () => {
  withDb(
    (db) => {
      addActivity(db, "b", { start_time: "2026-08-02T06:30:00+00:00" });
      addActivity(db, "z", { start_time: "2026-08-01T06:30:00+00:00" });
      addActivity(db, "a", { start_time: "2026-08-01T06:30:00+00:00" });
    },
    (path) => {
      assert.deepEqual(readDisplayFiles(path).activities.activities.map((a) => a.id), ["a", "z", "b"]);
    },
  );
});

test("missing database yields empty files and a sync warning", () => {
  const warnings: string[] = [];
  const files = readDisplayFiles("/nonexistent/dir/activities.sqlite", (m) => warnings.push(m));
  assert.deepEqual(files.routes, { v: 4, routes: {} });
  assert.deepEqual(files.activities, { v: 1, activities: [] });
  assert.equal(files.details.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sync/);
});

test("writeDisplayFiles empties the output folder first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "display-out-"));
  try {
    mkdirSync(join(dir, "activity"), { recursive: true });
    writeFileSync(join(dir, "activity", "stale.json"), "{}");
    const files = readDisplayFiles("/nonexistent/x.sqlite", () => {});
    await writeDisplayFiles(files, dir);
    assert.ok(!existsSync(join(dir, "activity", "stale.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "routes.json"), "utf8")), { v: 4, routes: {} });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "activities.json"), "utf8")), { v: 1, activities: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
