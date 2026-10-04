import { test } from "node:test";
import assert from "node:assert/strict";
import type { GeoCity } from "./city-types.ts";
import {
  ORIGIN,
  bucketCap,
  bucketIndex,
  haversineM,
  popFloor,
  selectCandidates,
} from "./build-city-distances.ts";

// --- Stage A ---------------------------------------------------------------

/** Meters per degree of latitude along a meridian (R = 6,371,008.8 m). */
const M_PER_DEG = 111_195.08;

/**
 * A city `km` due south of the origin. A meridian is a great circle, so the
 * Haversine distance is exactly `km` — handy for placing cities in buckets.
 */
function cityAt(id: number, km: number, over: Partial<GeoCity> = {}): GeoCity {
  return {
    id,
    name: `C${id}`,
    country: "XX",
    lat: ORIGIN.lat - (km * 1000) / M_PER_DEG,
    lon: ORIGIN.lon,
    population: 1_000_000,
    fc: "PPL",
    ...over,
  };
}

test("haversineM: one degree of latitude", () => {
  const d = haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - M_PER_DEG) < 1, `got ${d}`);
});

test("haversineM: Ljubljana → Zagreb ≈ 117 km", () => {
  const d = haversineM(ORIGIN, { lat: 45.815, lon: 15.9819 });
  assert.ok(d > 116_000 && d < 118_500, `got ${d}`);
});

test("popFloor: 15k near, 50k at 2,000 km, 100k far, never decreasing", () => {
  assert.equal(popFloor(100_000), 15_000);
  assert.equal(popFloor(300_000), 15_000);
  assert.equal(popFloor(2_000_000), 50_000);
  assert.equal(popFloor(10_000_000), 100_000);
  let prev = 0;
  for (let km = 10; km <= 12_000; km += 10) {
    const f = popFloor(km * 1000);
    assert.ok(f >= prev, `floor dropped at ${km} km`);
    prev = f;
  }
});

test("bucketIndex: 20 bins per decade from 20 km, null outside 20 km..12,000 km", () => {
  assert.equal(bucketIndex(19_000), null);
  assert.equal(bucketIndex(20_000), 0);
  assert.equal(bucketIndex(100_000), 13);
  assert.equal(bucketIndex(12_000_000), null);
});

test("bucketCap: K=10 below 6,000 km, K=3 beyond", () => {
  assert.equal(bucketCap(bucketIndex(1_000_000)!), 10);
  assert.equal(bucketCap(bucketIndex(5_900_000)!), 10);
  assert.equal(bucketCap(bucketIndex(8_000_000)!), 3);
});

test("selectCandidates: short and far buckets are both populated", () => {
  const out = selectCandidates([cityAt(1, 25), cityAt(2, 1000), cityAt(3, 9000)]);
  assert.deepEqual(out.map((c) => c.id), [1, 2, 3]);
  assert.ok(Math.abs(out[0].gcM - 25_000) < 1);
});

test("selectCandidates: applies the distance-scaled population floor", () => {
  const out = selectCandidates([
    cityAt(1, 25, { population: 15_000 }), // floor 15k → kept
    cityAt(2, 1000, { population: 20_000 }), // floor ~32k → dropped
  ]);
  assert.deepEqual(out.map((c) => c.id), [1]);
});

test("selectCandidates: keeps 10 per near bucket and 3 per far bucket", () => {
  const near = Array.from({ length: 15 }, (_, i) => cityAt(100 + i, 1000 - i)); // bucket 33
  const far = Array.from({ length: 6 }, (_, i) => cityAt(200 + i, 8000 + i)); // bucket 52
  const out = selectCandidates([...near, ...far]);
  assert.equal(out.filter((c) => c.id < 200).length, 10);
  assert.equal(out.filter((c) => c.id >= 200).length, 3);
});

test("selectCandidates: national capital wins its bucket over bigger cities", () => {
  const big = Array.from({ length: 10 }, (_, i) => cityAt(100 + i, 990 + i));
  const capital = cityAt(1, 995, { population: 40_000, fc: "PPLC" });
  const out = selectCandidates([...big, capital]);
  assert.equal(out.length, 10);
  assert.ok(out.some((c) => c.id === 1));
});

test("selectCandidates: regional capital ranks at 1.5x population", () => {
  const big = Array.from({ length: 9 }, (_, i) => cityAt(100 + i, 990 + i));
  const ppl = cityAt(1, 995, { population: 120_000 });
  const ppla = cityAt(2, 996, { population: 100_000, fc: "PPLA" }); // ranks as 150k
  const ids = selectCandidates([...big, ppl, ppla]).map((c) => c.id);
  assert.ok(ids.includes(2));
  assert.ok(!ids.includes(1));
});

test("selectCandidates: output is independent of input order", () => {
  const cities = [
    ...Array.from({ length: 15 }, (_, i) => cityAt(100 + i, 1000 - i, { population: 500_000 })),
    cityAt(1, 25),
    cityAt(2, 9000),
  ];
  const a = selectCandidates(cities).map((c) => c.id);
  const b = selectCandidates([...cities].reverse()).map((c) => c.id);
  assert.deepEqual(a, b);
});
