import { test } from "node:test";
import assert from "node:assert/strict";
import { routeProfile } from "./routeProfile.ts";
import type { DetailFile } from "./types.ts";

const detail = (d: (number | null)[] | undefined, alt: (number | null)[] | undefined): DetailFile => ({
  v: 1,
  step: 5,
  t: (d ?? alt ?? []).map((_, i) => i * 5),
  ...(d ? { d } : {}),
  ...(alt ? { alt } : {}),
});

test("samples elevation at evenly spaced fractions of the distance", () => {
  // A steady climb from 100 m to 200 m over 1 km: every bin lies on the line, and the
  // 3-point mean of a straight line is the line itself; the end bins average two points.
  const p = routeProfile(detail([0, 500, 1000], [100, 150, 200]), 5)!;
  assert.deepEqual(p, [113, 125, 150, 175, 188]);
});

test("the profile depends on fractions of distance, not on sample spacing", () => {
  const dense = routeProfile(detail([0, 250, 500, 750, 1000], [100, 100, 100, 100, 100]), 4);
  const sparse = routeProfile(detail([0, 1000], [100, 100]), 4);
  assert.deepEqual(dense, [100, 100, 100, 100]);
  assert.deepEqual(sparse, dense);
});

test("smooths a one-sample spike", () => {
  const p = routeProfile(detail([0, 100, 200, 300, 400], [100, 100, 130, 100, 100]), 5)!;
  assert.deepEqual(p, [100, 110, 110, 110, 100]);
});

test("skips samples missing distance or altitude", () => {
  const p = routeProfile(detail([0, null, 1000, 2000], [100, 999, null, 200]), 3)!;
  assert.deepEqual(p, [125, 150, 175]);
});

test("repeated distances (a stop) do not divide by zero", () => {
  const p = routeProfile(detail([0, 500, 500, 1000], [100, 120, 140, 160]), 3)!;
  assert.ok(p.every(Number.isFinite), String(p));
});

test("null without distance, altitude, two samples or any distance covered", () => {
  assert.equal(routeProfile(detail(undefined, [100, 101])), null);
  assert.equal(routeProfile(detail([0, 10], undefined)), null);
  assert.equal(routeProfile(detail([0, 10], [100, null])), null);
  assert.equal(routeProfile(detail([5, 5, 5], [100, 101, 102])), null);
});

test("64 points by default", () => {
  const n = 1000;
  const p = routeProfile(
    detail(
      Array.from({ length: n }, (_, i) => i * 7),
      Array.from({ length: n }, (_, i) => 300 + Math.sin(i / 50) * 40),
    ),
  )!;
  assert.equal(p.length, 64);
  assert.ok(p.every(Number.isInteger));
});
