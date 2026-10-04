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

// --- Stage B: OSRM ---------------------------------------------------------

import polyline from "@mapbox/polyline";
import {
  MAX_ATTEMPTS,
  USER_AGENT,
  evaluateRoute,
  fetchRoute,
  makeThrottle,
  type Clock,
  type OsrmResponse,
  type RouteDeps,
} from "./build-city-distances.ts";

type LngLat = [number, number];

function osrmOk(
  coords: LngLat[],
  distance: number,
  steps: { mode: string; distance: number }[] = [{ mode: "cycling", distance }],
): OsrmResponse {
  return { code: "Ok", routes: [{ distance, geometry: { coordinates: coords }, legs: [{ steps }] }] };
}

/** Clock that advances only through sleep(), recording every sleep. */
function fakeClock() {
  const state = { t: 0, sleeps: [] as number[] };
  const clock: Clock = {
    now: () => state.t,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
  };
  return { clock, state };
}

/** RouteDeps whose fetch replays `responses` in order and logs call times. */
function stubDeps(responses: (() => Response)[]) {
  const { clock, state } = fakeClock();
  const calls: { url: string; init?: RequestInit; at: number }[] = [];
  const deps: RouteDeps = {
    clock,
    throttle: makeThrottle(1000, clock),
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init, at: state.t });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next();
    }) as unknown as typeof fetch,
  };
  return { deps, calls, state };
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ZAGREB_LL = { lat: 45.815, lon: 15.9819 };
const LINE: LngLat[] = [[14.5058, 46.0569], [15.2, 45.95], [15.9819, 45.815]];

test("evaluateRoute: Ok without ferries is accepted, rounded and round-trips", () => {
  const out = evaluateRoute(osrmOk(LINE, 153_012.4));
  assert.ok(out.ok);
  assert.equal(out.route.m, 153_012);
  const back = polyline.decode(out.route.poly).map(([lat, lng]) => [lng, lat]);
  assert.equal(back.length, 3);
  back.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - LINE[i][0]) < 1e-5 && Math.abs(p[1] - LINE[i][1]) < 1e-5);
  });
});

test("evaluateRoute: simplifies at 500 m", () => {
  // Middle point ~110 m off a straight line → dropped at 500 m tolerance.
  const out = evaluateRoute(osrmOk([[14, 46], [14.5, 46.001], [15, 46]], 77_000));
  assert.ok(out.ok);
  assert.equal(polyline.decode(out.route.poly).length, 2);
});

test("evaluateRoute: a short river ferry is accepted", () => {
  const out = evaluateRoute(
    osrmOk(LINE, 1_219_000, [{ mode: "walking", distance: 1_211_000 }, { mode: "ferry", distance: 8_000 }]),
  );
  assert.ok(out.ok);
});

test("evaluateRoute: more than 20 km of ferry rejects the profile", () => {
  const out = evaluateRoute(osrmOk(LINE, 3_000_000, [{ mode: "ferry", distance: 439_000 }]));
  assert.deepEqual(out, { ok: false, reason: "ferry" });
});

test("evaluateRoute: ferry distance is summed across legs and steps", () => {
  const res = osrmOk(LINE, 900_000, [{ mode: "ferry", distance: 12_000 }]);
  res.routes![0].legs.push({ steps: [{ mode: "ferry", distance: 12_000 }] });
  assert.deepEqual(evaluateRoute(res), { ok: false, reason: "ferry" });
});

test("evaluateRoute: NoRoute is rejected with its code", () => {
  assert.deepEqual(evaluateRoute({ code: "NoRoute" }), { ok: false, reason: "NoRoute" });
});

test("fetchRoute: builds the OSRM URL and sends the User-Agent", async () => {
  const { deps, calls } = stubDeps([json(osrmOk(LINE, 153_000))]);
  const res = await fetchRoute("cycling", ZAGREB_LL, deps);
  assert.equal(res.kind, "measured");
  assert.equal(
    calls[0].url,
    "https://routing.openstreetmap.de/routed-bike/route/v1/driving/" +
      "14.5058,46.0569;15.9819,45.815?overview=full&geometries=geojson&steps=true",
  );
  assert.equal((calls[0].init?.headers as Record<string, string>)["User-Agent"], USER_AGENT);
});

test("fetchRoute: walking uses routed-foot", async () => {
  const { deps, calls } = stubDeps([json(osrmOk(LINE, 143_000))]);
  await fetchRoute("walking", ZAGREB_LL, deps);
  assert.match(calls[0].url, /\/routed-foot\//);
});

test("fetchRoute: HTTP 400 NoRoute is a measured rejection, not a retry", async () => {
  const { deps, calls } = stubDeps([json({ code: "NoRoute" }, 400)]);
  const res = await fetchRoute("cycling", ZAGREB_LL, deps);
  assert.deepEqual(res, { kind: "measured", outcome: { ok: false, reason: "NoRoute" } });
  assert.equal(calls.length, 1);
});

test("fetchRoute: 429 then Ok is retried", async () => {
  const { deps, calls } = stubDeps([json({}, 429), json(osrmOk(LINE, 153_000))]);
  const res = await fetchRoute("cycling", ZAGREB_LL, deps);
  assert.equal(res.kind, "measured");
  assert.equal(calls.length, 2);
});

test("fetchRoute: repeated timeouts are retried, then reported as failed", async () => {
  const timeout = () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const { deps, calls } = stubDeps([timeout, timeout, timeout]);
  const res = await fetchRoute("cycling", ZAGREB_LL, deps);
  assert.equal(res.kind, "failed");
  assert.match((res as { reason: string }).reason, /TimeoutError/);
  assert.equal(calls.length, MAX_ATTEMPTS);
});

test("throttle: request starts are spaced at least 1 s apart", async () => {
  const { deps, calls } = stubDeps([
    json(osrmOk(LINE, 1)), json({}, 503), json(osrmOk(LINE, 1)), json(osrmOk(LINE, 1)),
  ]);
  await fetchRoute("cycling", ZAGREB_LL, deps);
  await fetchRoute("cycling", ZAGREB_LL, deps); // 503 then Ok
  await fetchRoute("walking", ZAGREB_LL, deps);
  assert.equal(calls.length, 4);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].at - calls[i - 1].at >= 1000, `gap ${i}: ${calls[i].at - calls[i - 1].at}`);
  }
});
