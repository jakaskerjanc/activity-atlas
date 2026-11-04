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

test("elevation every step metres, relative to the start", () => {
  // A steady 10% climb from 300 m over 400 m of distance. The 3-point mean keeps a
  // straight line except at the ends, which average two points: the first is 305, so
  // every point is measured from there.
  const p = routeProfile(detail([0, 400], [300, 340]), 100)!;
  assert.deepEqual(p, [0, 5, 15, 25, 30]);
});

test("the last point is the last whole step covered", () => {
  assert.equal(routeProfile(detail([0, 250], [100, 100]), 100)!.length, 3);
  assert.equal(routeProfile(detail([0, 300], [100, 100]), 100)!.length, 4);
});

test("smooths a one-sample spike", () => {
  const p = routeProfile(detail([0, 100, 200, 300, 400], [100, 100, 130, 100, 100]), 100)!;
  assert.deepEqual(p, [0, 10, 10, 10, 0]);
});

test("a descent goes negative", () => {
  const p = routeProfile(detail([0, 200], [500, 300]), 100)!;
  assert.deepEqual(p, [0, -50, -100]);
});

test("skips samples missing distance or altitude", () => {
  const p = routeProfile(detail([0, null, 100, 200], [100, 999, null, 200]), 100)!;
  assert.deepEqual(p, [0, 25, 50]);
});

test("repeated distances (a stop) do not divide by zero", () => {
  const p = routeProfile(detail([0, 100, 100, 200], [100, 120, 140, 160]), 100)!;
  assert.ok(p.every(Number.isFinite), String(p));
});

test("null without distance, altitude, two samples, or one whole step", () => {
  assert.equal(routeProfile(detail(undefined, [100, 101])), null);
  assert.equal(routeProfile(detail([0, 500], undefined)), null);
  assert.equal(routeProfile(detail([0, 500], [100, null])), null);
  assert.equal(routeProfile(detail([5, 5, 5], [100, 101, 102])), null);
  assert.equal(routeProfile(detail([0, 99], [100, 101]), 100), null);
});

test("100 m steps by default, whole metres", () => {
  const n = 1000;
  const p = routeProfile(
    detail(
      Array.from({ length: n }, (_, i) => i * 7),
      Array.from({ length: n }, (_, i) => 300 + Math.sin(i / 50) * 40),
    ),
  )!;
  assert.equal(p.length, Math.floor((999 * 7) / 100) + 1);
  assert.ok(p.every(Number.isInteger));
  assert.equal(p[0], 0);
});
