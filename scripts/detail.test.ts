import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDetail, detailStep, DETAIL_MAX_POINTS, type Streams } from "./detail.ts";

const range = (n: number, f: (i: number) => number | null = (i) => i) => Array.from({ length: n }, (_, i) => f(i));

test("step is 5 s up to ~5000 s, then grows to keep the point cap", () => {
  assert.equal(detailStep(4995), 5);
  assert.equal(detailStep(4999), 5);
  assert.equal(detailStep(5000), 6);
  assert.equal(detailStep(9000), 10);
});

test("bucket means per channel", () => {
  const d = buildDetail({ time: range(10), hr: range(10, (i) => 100 + i) })!;
  assert.equal(d.v, 1);
  assert.equal(d.step, 5);
  assert.deepEqual(d.t, [2, 7]);
  assert.deepEqual(d.hr, [102, 107]);
});

test("missing samples are skipped, an all-missing bucket is null", () => {
  const hr = [100, null, 104, null, null, null, null, null, null, null];
  const d = buildDetail({ time: range(10), hr })!;
  assert.deepEqual(d.hr, [102, null]);
});

test("a pause makes no points", () => {
  const time = [0, 1, 2, 3, 4, 100, 101, 102, 103, 104];
  const d = buildDetail({ time, hr: range(10, () => 120) })!;
  assert.deepEqual(d.t, [2, 102]);
});

test("never more than 1000 points", () => {
  const n = 44479;
  const d = buildDetail({ time: range(n), hr: range(n, () => 130) })!;
  assert.ok(d.t.length <= DETAIL_MAX_POINTS, `${d.t.length} points`);
  assert.equal(d.step, detailStep(n - 1));
  assert.equal(d.hr!.length, d.t.length);
});

test("rounding", () => {
  const d = buildDetail({
    time: [0], lat: [46.0512345], lon: [14.5058149], altitude: [312.44],
    speed: [1.2345], distance: [4.6], hr: [130.4], cadence: [80.6],
  })!;
  assert.deepEqual(d.lat, [46.05123]);
  assert.deepEqual(d.lon, [14.50581]);
  assert.deepEqual(d.alt, [312.4]);
  assert.deepEqual(d.speed, [1.23]);
  assert.deepEqual(d.d, [5]);
  assert.deepEqual(d.hr, [130]);
  assert.deepEqual(d.cad, [81]);
});

test("omits absent and empty channels", () => {
  const d = buildDetail({ time: range(10), hr: range(10, () => null), altitude: range(10, () => 300) })!;
  assert.ok(!("cad" in d));
  assert.ok(!("hr" in d));
  assert.ok("alt" in d);
  const indoor = buildDetail({ time: range(10), hr: range(10, () => 90), distance: range(10, () => 0), speed: range(10, () => 0) })!;
  assert.ok(!("d" in indoor));
  assert.ok(!("speed" in indoor));
});

test("derives speed from distance when the stream has none", () => {
  const d = buildDetail({ time: [0, 5, 10], distance: [0, 10, 30] })!;
  assert.deepEqual(d.speed, [2, 2, 4]);
});

test("null when nothing chartable", () => {
  assert.equal(buildDetail({ time: range(10), cadence: range(10, () => 80) }), null);
  assert.equal(buildDetail({ time: [], hr: [] }), null);
});

test("streams type accepts every shipped channel", () => {
  const s: Streams = { time: [0], distance: [0], lat: [0], lon: [0], altitude: [0], hr: [0], speed: [0], cadence: [0] };
  assert.ok(s);
});
