import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyLngLat } from "./simplify.ts";

type LngLat = [number, number];

test("returns input unchanged when fewer than 3 points", () => {
  const one: LngLat[] = [[14.5, 46.06]];
  const two: LngLat[] = [
    [14.5, 46.06],
    [14.6, 46.07],
  ];
  assert.equal(simplifyLngLat(one, 5), one);
  assert.equal(simplifyLngLat(two, 5), two);
});

test("collapses a straight collinear line to its two endpoints", () => {
  const line: LngLat[] = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.003, 0],
  ];
  assert.deepEqual(simplifyLngLat(line, 5), [
    [0, 0],
    [0.003, 0],
  ]);
});

test("always preserves first and last points", () => {
  const pts: LngLat[] = [
    [0, 0],
    [0.001, 0.00002],
    [0.002, 0],
    [0.003, 0.00001],
    [0.004, 0],
  ];
  const out = simplifyLngLat(pts, 5);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});

test("keeps a deviation larger than the tolerance", () => {
  // Middle point sits ~111 m off the line — far above a 5 m tolerance.
  const spike: LngLat[] = [
    [0, 0],
    [0.001, 0.001],
    [0.002, 0],
  ];
  assert.equal(simplifyLngLat(spike, 5).length, 3);
});

test("drops a wiggle smaller than the tolerance", () => {
  // Middle point sits ~2.2 m off the line — below a 5 m tolerance.
  const wiggle: LngLat[] = [
    [0, 0],
    [0.001, 0.00002],
    [0.002, 0],
  ];
  assert.deepEqual(simplifyLngLat(wiggle, 5), [
    [0, 0],
    [0.002, 0],
  ]);
});

test("strictly reduces point count on a dense noisy input", () => {
  const dense: LngLat[] = [];
  for (let i = 0; i <= 2000; i++) {
    // A gentle arc plus sub-meter noise that a 5 m tolerance should absorb.
    const lng = i * 0.0001;
    const lat = Math.sin(i / 200) * 0.01 + ((i % 3) - 1) * 0.000003;
    dense.push([lng, lat]);
  }
  const out = simplifyLngLat(dense, 5);
  assert.ok(out.length < dense.length, "should remove points");
  assert.ok(out.length >= 2, "keeps at least the endpoints");
});
