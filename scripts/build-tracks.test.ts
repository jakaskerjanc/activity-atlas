import { test } from "node:test";
import assert from "node:assert/strict";
import polyline from "@mapbox/polyline";
import { buildTracks, type ActivityRow } from "./build-tracks.ts";

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "s:111", name: "Run", type: "Run", start_time: "2026-08-01T06:30:00+00:00",
    distance: 1000, moving_time: 600, elevation_gain: 10,
    polyline: polyline.encode([[46.0, 14.0], [46.001, 14.001], [46.002, 14.0]]),
    ...over,
  } as ActivityRow;
}

test("builds an encoded track with namespaced id", () => {
  const stats = { rawPoints: 0, keptPoints: 0 };
  const out = buildTracks([row()], stats);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "s:111");
  assert.equal(out[0].elevation_gain, 10);
  assert.ok(out[0].poly.length > 0);
});

test("skips rows with no polyline", () => {
  const out = buildTracks([row({ id: "g:1", polyline: "" })], { rawPoints: 0, keptPoints: 0 });
  assert.equal(out.length, 0);
});
