import { test } from "node:test";
import assert from "node:assert/strict";
import { toRecord, type ActivityRow, type UsableRow } from "./numbers.ts";

function row(over: Partial<ActivityRow> = {}): UsableRow {
  return {
    id: "abc", name: "Hike", type: "Hike",
    start_time: "2026-08-01T06:30:00+00:00", start_local: "2026-08-01T08:30:00",
    distance: 14210.4, moving_time: 16020, elapsed_time: 19811,
    elevation_gain: 1204, elevation_loss: 1198, avg_hr: 131, max_hr: 172,
    has_gps: 1, has_hr: 1, has_altitude: 1, has_cadence: 1, has_power: 1,
    polyline: "", streams_sha256: null,
    ...over,
  } as UsableRow;
}

const NUMBERS = ["distance", "moving_time", "elapsed_time", "elevation_gain", "elevation_loss", "avg_hr", "max_hr"] as const;

test("keeps every present value under its record key", () => {
  const r = toRecord(row(), [{ provider: "strava", id: "1" }], false, {}, [2072, 5217, 1773, 0, 0, 0]);
  assert.deepEqual(r, {
    id: "abc", name: "Hike", type: "Hike",
    ts: 1785565800, start_date: "2026-08-01T06:30:00+00:00", start_local: "2026-08-01T08:30:00",
    distance: 14210.4, moving_time: 16020, elapsed_time: 19811,
    elevation_gain: 1204, elevation_loss: 1198, avg_hr: 131, max_hr: 172,
    hr_zones: [2072, 5217, 1773, 0, 0, 0],
    channels: ["gps", "hr", "altitude", "cadence", "power"],
    sources: [{ provider: "strava", id: "1" }],
  });
});

test("drops null numbers", () => {
  for (const k of NUMBERS) {
    const r = toRecord(row({ [k]: null }), [], false);
    assert.ok(!(k in r), k);
  }
});

test("drops provider zeros", () => {
  for (const k of ["distance", "moving_time", "elapsed_time", "avg_hr", "max_hr"] as const) {
    assert.ok(!(k in toRecord(row({ [k]: 0 }), [], false)), k);
  }
  const noAlt = toRecord(row({ elevation_gain: 0, elevation_loss: 0, has_altitude: 0 }), [], false);
  assert.ok(!("elevation_gain" in noAlt));
  assert.ok(!("elevation_loss" in noAlt));
  const flat = toRecord(row({ elevation_gain: 0, elevation_loss: 0, has_altitude: 1 }), [], false);
  assert.equal(flat.elevation_gain, 0);
  assert.equal(flat.elevation_loss, 0);
});

test("hr zones are the recomputed ones passed in, absent when unknown", () => {
  assert.deepEqual(toRecord(row(), [], false, {}, [1, 2, 3, 4, 5, 6]).hr_zones, [1, 2, 3, 4, 5, 6]);
  assert.ok(!("hr_zones" in toRecord(row(), [], false)));
});

test("channels follow the flags", () => {
  const r = toRecord(row({ has_gps: 1, has_hr: 1, has_altitude: 0, has_cadence: 0, has_power: 0 }), [], false);
  assert.deepEqual(r.channels, ["gps", "hr"]);
});

test("ts and start_date", () => {
  const r = toRecord(row(), [], false);
  assert.equal(r.ts, 1785565800);
  assert.equal(r.start_date, "2026-08-01T06:30:00+00:00");
});

test("detail flag", () => {
  assert.equal(toRecord(row(), [], true).detail, true);
  assert.ok(!("detail" in toRecord(row(), [], false)));
});

test("never writes null", () => {
  const allNull = row({
    start_local: null, distance: null, moving_time: null, elapsed_time: null,
    elevation_gain: null, elevation_loss: null, avg_hr: null, max_hr: null,
  });
  assert.ok(!JSON.stringify(toRecord(allNull, [], false)).includes("null"));
});
