# Distance → Comparison-City Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a committed, precomputed dataset of ~520 cities with real OSRM bike/foot route distances and simplified route lines from Ljubljana, plus pure, tested app-side helpers that turn an activity total into a comparison city — no UI.

**Architecture:** One offline build script (`scripts/build-city-distances.ts`) runs three stages: A selects candidate cities from a vendored GeoNames subset (pure), B measures each with the public FOSSGIS OSRM server at ≤1 req/s with a resumable JSONL cache (network, behind an injected `fetch`/clock seam), C validates coverage and writes `app/public/city-distances.json` (committed). The app gets `cities.ts` (lazy fetch + decode) and `cityMatch.ts` (grouping, seeded RNG, weighted pick), neither imported at startup.

**Tech Stack:** TypeScript, `tsx` + `node:test` (scripts), `@mapbox/polyline`, existing `scripts/simplify.ts`; React app side tested with vitest; pnpm workspaces.

**Spec:** `docs/2026-09-19-distance-city-comparison-design.md`

## Global Constraints

- **Origin is always Ljubljana:** `{ name: "Ljubljana", lat: 46.0569, lon: 14.5058 }`.
- **Router:** `https://routing.openstreetmap.de/routed-{bike|foot}/route/v1/driving/{lon,lat};{lon,lat}?overview=full&geometries=geojson&steps=true`. Mapbox is never used for routing.
- **OSRM usage policy:** strictly sequential, **≥ 1 s between request starts**, User-Agent `strava-on-maps-build (https://github.com/jakaskerjanc/strava-on-maps)`, 30 s per-request timeout, max 3 attempts on 429/5xx/timeout/network error. No live network in tests.
- **Ferry rule:** reject a profile's route when the **sum** of `mode === "ferry"` step distances exceeds **20 km**. Drop a city only if **both** profiles are `null`.
- **Route encoding:** simplify with `simplifyLngLat` at **500 m**, then Google polyline precision 5, `[lat,lng]` order (same as `build-tracks.ts`). Decoding flips back to `[lng,lat]`.
- **Stage A defaults:** 20 bins per decade from 20 km to 12,000 km; K = 10 for buckets whose lower edge is < 6,000 km, K = 3 beyond; `PPLC` ranks first, `PPLA` ranks at 1.5× population; population floor 15,000 ≤ 300 km rising log-linearly to 50,000 at 2,000 km and 100,000 at 6,000 km+.
- **Stage C:** fail (no output written) on any coverage hole — a target on a 50-per-decade log grid from 20 km to 6,000 km with no city whose route `m` is within ±40 % — and on any failed request. Warn on route < great-circle or route > 3× great-circle.
- **Matching defaults:** band ±5 %, widened ×2 per step up to ±40 %; weight = population × 2 (`PPLC`) × 1.5 (`PPLA`).
- **Wire names:** profile keys on the wire and in the app are `"cycling"` / `"walking"`; OSRM path names are `bike` / `foot`. Payload `v: 1`, `router: "osrm-fossgis"`, `simplifyM: 500`.
- **Wire types live in `scripts/city-types.ts`**, mirrored in `app/src/types.ts` (keep-in-sync convention, like `EncodedTrack`).
- `build:cities` is **not** wired into `build`. `app/public/city-distances.json` **is** committed; `scripts/data/.city-distances-cache.jsonl` is gitignored.
- Use **pnpm** (`packageManager: pnpm@10`). In a fresh worktree run `pnpm install` once before anything else.
- Commit messages: short conventional prefix, e.g. `feat: city stage A selection`.

## Review Focus

- **Interrupted build run** (Ctrl-C mid-append leaves a truncated last line in the cache) → the re-run resumes from the cache instead of crashing on `JSON.parse`. Pinned in Task 4 (`parseCache` skips unparsable lines).
- **Some requests still failing after retries** → the script must not write a dataset with silently missing cities; it exits non-zero and asks for a re-run (cache keeps the successes). Pinned in Task 5 (`blockingProblems`) and Task 4 (failures are not cached).
- **Several short ferries that add up past 20 km** → rejected, because the rule is about total ferry distance, not the longest leg. Pinned in Task 3.
- **Changing the 500 m tolerance and re-running without `--fresh`** → cached routes encoded at the old tolerance are ignored and re-measured, not mixed into the new file. Pinned in Task 4 (`parseCache` filters on `simplifyM`).
- **A zero or non-positive total** (e.g. the filter only contains rides, so the walking total is 0) → `pickCity` returns `under`, never a random city with a `0`/`NaN` ratio. Pinned in Task 10.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/city-types.ts` (new) | Wire + build types: `Profile`, `GeoCity`, `Candidate`, `EncodedCityRoute`, `EncodedCity`, `CityDistancePayload` |
| `scripts/build-city-distances.ts` (new) | Stage A (select), B (OSRM fetch, cache, enrich), C (validate, payload, report), `main()` — pure parts exported, `main()` guarded like `build-tracks.ts` |
| `scripts/build-city-distances.test.ts` (new) | node:test for stages A/B/C — each task appends a section |
| `scripts/prepare-geonames.ts` (new) | `cities15000.txt` → `scripts/data/geonames-cities.json` |
| `scripts/prepare-geonames.test.ts` (new) | parsing + prefilter tests |
| `scripts/data/geonames-cities.json` (new, generated, committed) | vendored, pre-filtered build input |
| `app/public/city-distances.json` (new, generated, committed) | the shipped dataset |
| `app/src/types.ts` (modify) | app-side copy of the wire types |
| `app/src/cities.ts` + `.test.ts` (new) | `decodeCities`, `loadCities`, `CityRoute`, `CityDistance` |
| `app/src/cityMatch.ts` + `.test.ts` (new) | `activityGroup`, `groupTotals`, `seededRng`, `pickCity`, `CityPick` |
| `package.json`, `.gitignore`, `README.md` (modify) | `build:cities` script, cache ignore, regeneration docs |

Commands used throughout:
- Script tests: `pnpm exec tsx --test scripts/build-city-distances.test.ts` (all script tests: `pnpm test`)
- Script typecheck: `pnpm typecheck`
- App tests: `pnpm --filter app exec vitest run src/<file>.test.ts` (all: `pnpm --filter app test`)
- App typecheck: `pnpm --filter app exec tsc --noEmit`

---

### Task 1: Wire types and stage A candidate selection

**Files:**
- Create: `scripts/city-types.ts`
- Create: `scripts/build-city-distances.ts`
- Test: `scripts/build-city-distances.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces (from `scripts/city-types.ts`): `Profile`, `LatLon`, `GeoCity`, `Candidate`, `EncodedCityRoute`, `EncodedCity`, `CityDistancePayload` (definitions below).
- Produces (from `scripts/build-city-distances.ts`): `ORIGIN: { name: string } & LatLon`, `haversineM(a: LatLon, b: LatLon): number`, `popFloor(distM: number): number`, `bucketIndex(distM: number): number | null`, `bucketLowerM(i: number): number`, `bucketCap(i: number): number`, `selectCandidates(cities: GeoCity[], origin?: LatLon): Candidate[]` (sorted by `gcM` asc, then `id`).

- [ ] **Step 0: Install dependencies (fresh worktree only)**

Run: `pnpm install`
Expected: completes; `node_modules/.bin/tsx` exists.

- [ ] **Step 1: Create the wire types**

`scripts/city-types.ts`:

```ts
// Types for the city-distance dataset (scripts/build-city-distances.ts →
// app/public/city-distances.json). Keep the wire types in sync with the
// frontend copy in app/src/types.ts.

/** Comparison group; also the per-city route key on the wire. */
export type Profile = "cycling" | "walking";

export interface LatLon {
  lat: number;
  lon: number;
}

/** One row of the vendored GeoNames subset (scripts/data/geonames-cities.json). */
export interface GeoCity extends LatLon {
  /** GeoNames geonameid — stable key. */
  id: number;
  name: string;
  /** ISO 3166-1 alpha-2 country code */
  country: string;
  population: number;
  /** GeoNames feature code: PPLC national capital, PPLA regional capital, PPL… */
  fc: string;
}

/** A stage A pick: a GeoCity plus its great-circle distance from the origin. */
export interface Candidate extends GeoCity {
  /** great-circle meters from the origin */
  gcM: number;
}

/** One measured route on the wire. */
export interface EncodedCityRoute {
  /** OSRM route distance, meters */
  m: number;
  /** Google-encoded polyline, [lat,lng] precision-5, simplified to `simplifyM`. */
  poly: string;
}

/** One city on the wire; a profile is null when OSRM had no acceptable route. */
export interface EncodedCity extends GeoCity {
  cycling: EncodedCityRoute | null;
  walking: EncodedCityRoute | null;
}

/** Root shape of app/public/city-distances.json. */
export interface CityDistancePayload {
  /** Wire-format version, bumped on breaking shape changes. */
  v: number;
  /** ISO date (YYYY-MM-DD) the dataset was built */
  generated: string;
  router: string;
  /** Douglas–Peucker tolerance (meters) applied before encoding */
  simplifyM: number;
  origin: { name: string } & LatLon;
  /** Sorted by cycling.m asc; cities with cycling: null last. */
  cities: EncodedCity[];
}
```

- [ ] **Step 2: Write the failing stage A tests**

`scripts/build-city-distances.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts`
Expected: FAIL — cannot find module `./build-city-distances.ts`.

- [ ] **Step 4: Implement stage A**

`scripts/build-city-distances.ts`:

```ts
// Build app/public/city-distances.json: recognizable cities at real bike/foot
// route distances from Ljubljana, with simplified route lines, so the app can
// say "you rode X km — that's Ljubljana → Y". Network-bound and slow (~18 min),
// so it runs manually (`pnpm run build:cities`) and its output is committed.
// See docs/2026-09-19-distance-city-comparison-design.md.
//
//   stage A (pure)    select ~520 candidates from the vendored GeoNames subset
//   stage B (network) measure each with OSRM bike + foot, 1 req/s, cached
//   stage C (pure)    validate coverage + sanity, report, write

import type { Candidate, GeoCity, LatLon } from "./city-types.ts";

export const ORIGIN = { name: "Ljubljana", lat: 46.0569, lon: 14.5058 };

// --- Stage A: selection -----------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in meters. */
export function haversineM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * [distance m, population floor] anchors, log-interpolated between and clamped
 * outside. Low near the origin so short totals have candidates; high far out so
 * distant picks stay recognizable.
 */
const POP_FLOOR_ANCHORS: [number, number][] = [
  [300_000, 15_000],
  [2_000_000, 50_000],
  [6_000_000, 100_000],
];

/** Minimum population a city needs to be a candidate at `distM` from the origin. */
export function popFloor(distM: number): number {
  const a = POP_FLOOR_ANCHORS;
  if (distM <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    const [d0, p0] = a[i - 1];
    const [d1, p1] = a[i];
    if (distM <= d1) {
      const t = Math.log(distM / d0) / Math.log(d1 / d0);
      return Math.round(p0 * (p1 / p0) ** t);
    }
  }
  return a[a.length - 1][1];
}

export const BUCKET_MIN_M = 20_000;
export const BUCKET_MAX_M = 12_000_000;
/** 20 log bins per decade → each bin ~12 % wide. */
export const BINS_PER_DECADE = 20;
const K_NEAR = 10;
const K_FAR = 3;
/** Buckets starting at or beyond this keep K_FAR (far routes dominate file size). */
const K_SPLIT_M = 6_000_000;
/** Rank multiplier for regional capitals (PPLA) within a bucket. */
const PPLA_RANK_BOOST = 1.5;

/** Log-spaced distance bucket, or null outside [BUCKET_MIN_M, BUCKET_MAX_M). */
export function bucketIndex(distM: number): number | null {
  if (!(distM >= BUCKET_MIN_M) || distM >= BUCKET_MAX_M) return null;
  return Math.floor(BINS_PER_DECADE * Math.log10(distM / BUCKET_MIN_M));
}

/** Lower edge (meters) of bucket `i`. */
export function bucketLowerM(i: number): number {
  return BUCKET_MIN_M * 10 ** (i / BINS_PER_DECADE);
}

/** How many cities bucket `i` keeps. */
export function bucketCap(i: number): number {
  return bucketLowerM(i) < K_SPLIT_M ? K_NEAR : K_FAR;
}

/** Capitals first, then (PPLA-boosted) population desc, then id for determinism. */
function compareRank(a: GeoCity, b: GeoCity): number {
  const capA = a.fc === "PPLC" ? 1 : 0;
  const capB = b.fc === "PPLC" ? 1 : 0;
  if (capA !== capB) return capB - capA;
  const score = (c: GeoCity) => c.population * (c.fc === "PPLA" ? PPLA_RANK_BOOST : 1);
  return score(b) - score(a) || a.id - b.id;
}

/**
 * Stage A: bucket cities by great-circle distance from `origin` and keep the
 * best-known few per bucket. Great-circle is only a coarse filter; matching
 * later uses the real route distance from stage B.
 */
export function selectCandidates(cities: GeoCity[], origin: LatLon = ORIGIN): Candidate[] {
  const buckets = new Map<number, Candidate[]>();
  for (const c of cities) {
    const gcM = haversineM(origin, c);
    const b = bucketIndex(gcM);
    if (b === null || c.population < popFloor(gcM)) continue;
    const list = buckets.get(b) ?? [];
    list.push({ ...c, gcM });
    buckets.set(b, list);
  }
  const out: Candidate[] = [];
  for (const [b, list] of buckets) out.push(...list.sort(compareRank).slice(0, bucketCap(b)));
  return out.sort((x, y) => x.gcM - y.gcM || x.id - y.id);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts && pnpm typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/city-types.ts scripts/build-city-distances.ts scripts/build-city-distances.test.ts
git commit -m "feat: city stage A candidate selection"
```

---

### Task 2: GeoNames preparation script and vendored subset

**Files:**
- Create: `scripts/prepare-geonames.ts`
- Test: `scripts/prepare-geonames.test.ts`
- Create (generated): `scripts/data/geonames-cities.json`

**Interfaces:**
- Consumes: `ORIGIN`, `haversineM`, `bucketIndex`, `popFloor`, `selectCandidates` from Task 1; `GeoCity`, `LatLon` from `scripts/city-types.ts`.
- Produces: `parseGeonamesLine(line: string): GeoCity | null`, `prefilter(cities: GeoCity[], origin?: LatLon): GeoCity[]` (sorted by id), `serializeCities(cities: GeoCity[]): string`; the committed file `scripts/data/geonames-cities.json` (a `GeoCity[]` JSON array, one object per line).

- [ ] **Step 1: Write the failing tests**

`scripts/prepare-geonames.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeonamesLine, prefilter, serializeCities } from "./prepare-geonames.ts";
import type { GeoCity } from "./city-types.ts";

// cities15000.txt columns: 0 id, 1 name, 2 asciiname, 3 alternatenames, 4 lat,
// 5 lon, 6 feature class, 7 feature code, 8 country, … 14 population, …
const ZAGREB = [
  "3186886", "Zagreb", "Zagreb", "Agram,Zagabria", "45.81444", "15.97798", "P", "PPLC",
  "HR", "", "21", "", "", "", "698966", "", "158", "Europe/Zagreb", "2019-09-05",
].join("\t");

test("parseGeonamesLine: picks the seven fields", () => {
  assert.deepEqual(parseGeonamesLine(ZAGREB), {
    id: 3186886, name: "Zagreb", country: "HR", lat: 45.81444, lon: 15.97798,
    population: 698966, fc: "PPLC",
  });
});

test("parseGeonamesLine: rejects blank and short lines", () => {
  assert.equal(parseGeonamesLine(""), null);
  assert.equal(parseGeonamesLine("1\tX\tX"), null);
});

function geo(id: number, lat: number, lon: number, population: number): GeoCity {
  return { id, name: `C${id}`, country: "XX", lat, lon, population, fc: "PPL" };
}

test("prefilter: drops the origin itself, under-floor and out-of-range cities", () => {
  const out = prefilter([
    geo(4, 45.815, 15.9819, 700_000), // Zagreb-ish, kept
    geo(1, 46.0569, 14.5058, 280_000), // origin, < 20 km
    geo(3, 51.5, -0.12, 20_000), // London-ish distance, under floor
    geo(2, 45.815, 15.9819, 16_000), // ~117 km, floor 15k, kept
  ]);
  assert.deepEqual(out.map((c) => c.id), [2, 4]);
});

test("serializeCities: one object per line, parseable", () => {
  const text = serializeCities([geo(1, 1, 1, 1), geo(2, 2, 2, 2)]);
  assert.equal(text.split("\n").length, 4); // [ , row, row, ]
  assert.equal(JSON.parse(text).length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test scripts/prepare-geonames.test.ts`
Expected: FAIL — cannot find module `./prepare-geonames.ts`.

- [ ] **Step 3: Implement**

`scripts/prepare-geonames.ts`:

```ts
// Convert a downloaded GeoNames cities15000.txt into the vendored, pre-filtered
// build input scripts/data/geonames-cities.json. Rare manual step:
//
//   curl -L -o /tmp/cities15000.zip https://download.geonames.org/export/dump/cities15000.zip
//   unzip -o /tmp/cities15000.zip -d /tmp
//   pnpm exec tsx scripts/prepare-geonames.ts /tmp/cities15000.txt
//
// Keeps only rows stage A could select (in bucket range and above the
// distance-scaled population floor), with just the seven fields it needs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, bucketIndex, haversineM, popFloor } from "./build-city-distances.ts";
import type { GeoCity, LatLon } from "./city-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "data/geonames-cities.json");

/** One cities15000.txt row → GeoCity, or null for blank / malformed rows. */
export function parseGeonamesLine(line: string): GeoCity | null {
  const f = line.split("\t");
  if (f.length < 15) return null;
  const id = Number(f[0]);
  const lat = Number(f[4]);
  const lon = Number(f[5]);
  const population = Number(f[14]);
  if (![id, lat, lon, population].every(Number.isFinite)) return null;
  return { id, name: f[1], country: f[8], lat, lon, population, fc: f[7] };
}

/** Rows stage A could ever select, sorted by id for stable diffs. */
export function prefilter(cities: GeoCity[], origin: LatLon = ORIGIN): GeoCity[] {
  return cities
    .filter((c) => {
      const d = haversineM(origin, c);
      return bucketIndex(d) !== null && c.population >= popFloor(d);
    })
    .sort((a, b) => a.id - b.id);
}

/** JSON array with one city per line, so regenerations diff readably. */
export function serializeCities(cities: GeoCity[]): string {
  return `[\n${cities.map((c) => JSON.stringify(c)).join(",\n")}\n]`;
}

async function main() {
  const src = process.argv[2];
  if (!src) throw new Error("usage: tsx scripts/prepare-geonames.ts <cities15000.txt>");
  const rows = (await readFile(src, "utf8"))
    .split("\n")
    .map(parseGeonamesLine)
    .filter((c): c is GeoCity => c !== null);
  const kept = prefilter(rows);
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, serializeCities(kept) + "\n");
  console.log(`Kept ${kept.length} of ${rows.length} GeoNames rows → ${OUT_PATH}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test scripts/prepare-geonames.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Download GeoNames and generate the vendored subset**

```bash
curl -L -o /tmp/cities15000.zip https://download.geonames.org/export/dump/cities15000.zip
unzip -o /tmp/cities15000.zip -d /tmp
pnpm exec tsx scripts/prepare-geonames.ts /tmp/cities15000.txt
ls -lh scripts/data/geonames-cities.json
```

Expected: "Kept N of ~33,000 GeoNames rows"; file a few hundred KB to ~1 MB.

- [ ] **Step 6: Sanity-check stage A on the real data**

```bash
pnpm exec tsx -e '(async () => {
  const { readFileSync } = await import("node:fs");
  const { selectCandidates } = await import("./scripts/build-city-distances.ts");
  const c = selectCandidates(JSON.parse(readFileSync("scripts/data/geonames-cities.json", "utf8")));
  console.log(c.length, "candidates");
  console.log(c.filter((x) => x.gcM < 200_000).map((x) => x.name).join(", "));
})()'
```

Expected: roughly 450–600 candidates; the near list contains recognizable Slovenian/Croatian/Austrian/Italian towns (e.g. Kranj, Celje, Maribor, Zagreb, Klagenfurt, Trieste). If the count is far off, adjust `POP_FLOOR_ANCHORS` in `scripts/build-city-distances.ts`, re-run Step 5, and note it in the commit message.

- [ ] **Step 7: Commit**

```bash
git add scripts/prepare-geonames.ts scripts/prepare-geonames.test.ts scripts/data/geonames-cities.json
git commit -m "feat: vendored geonames subset + prepare script"
```

---

### Task 3: Stage B — OSRM response evaluation and throttled, retrying fetch

**Files:**
- Modify: `scripts/build-city-distances.ts` (append a stage B section)
- Test: `scripts/build-city-distances.test.ts` (append a section)

**Interfaces:**
- Consumes: `ORIGIN` (Task 1), `simplifyLngLat` from `scripts/simplify.ts`, `@mapbox/polyline`, `Profile`/`LatLon`/`EncodedCityRoute` types.
- Produces:
  - `SIMPLIFY_M = 500`, `MAX_FERRY_M = 20_000`, `MIN_REQUEST_GAP_MS = 1_000`, `MAX_ATTEMPTS = 3`, `USER_AGENT`
  - `interface OsrmResponse { code: string; message?: string; routes?: OsrmRoute[] }`
  - `type RouteOutcome = { ok: true; route: EncodedCityRoute } | { ok: false; reason: string }`
  - `type FetchResult = { kind: "measured"; outcome: RouteOutcome } | { kind: "failed"; reason: string }`
  - `interface Clock { now(): number; sleep(ms: number): Promise<void> }`, `realClock: Clock`
  - `interface RouteDeps { fetch: typeof fetch; clock: Clock; throttle: () => Promise<void> }`
  - `ferryMeters(route: OsrmRoute): number`, `evaluateRoute(res: OsrmResponse): RouteOutcome`, `osrmUrl(profile: Profile, dest: LatLon): string`, `makeThrottle(gapMs: number, clock: Clock): () => Promise<void>`, `fetchRoute(profile: Profile, dest: LatLon, deps: RouteDeps): Promise<FetchResult>`

- [ ] **Step 1: Append the failing tests**

Append to `scripts/build-city-distances.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts`
Expected: FAIL — `evaluateRoute` / `fetchRoute` / `makeThrottle` are not exported.

- [ ] **Step 3: Implement stage B fetch + evaluation**

Add to the imports at the top of `scripts/build-city-distances.ts`:

```ts
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { EncodedCityRoute, Profile } from "./city-types.ts";
```

(merge `Profile`/`EncodedCityRoute` into the existing `import type` line.)

Append:

```ts
// --- Stage B: OSRM measurement ---------------------------------------------

export const OSRM_BASE = "https://routing.openstreetmap.de";
const OSRM_PROFILE: Record<Profile, string> = { cycling: "bike", walking: "foot" };
export const USER_AGENT = "strava-on-maps-build (https://github.com/jakaskerjanc/strava-on-maps)";
/** Douglas–Peucker tolerance (meters) for stored route lines: overview quality. */
export const SIMPLIFY_M = 500;
/** Total ferry distance above which a profile's route is rejected. */
export const MAX_FERRY_M = 20_000;
/** The FOSSGIS server's policy: at most 1 request per second. */
export const MIN_REQUEST_GAP_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
/** Backoff before attempt n (n ≥ 2): BACKOFF_BASE_MS * 2^(n-2). */
const BACKOFF_BASE_MS = 2_000;

interface OsrmStep {
  mode: string;
  /** meters */
  distance: number;
}

export interface OsrmRoute {
  /** meters */
  distance: number;
  geometry: { coordinates: [number, number][] };
  legs: { steps: OsrmStep[] }[];
}

export interface OsrmResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
}

/** A measured profile: accepted route, or the reason it was rejected. */
export type RouteOutcome = { ok: true; route: EncodedCityRoute } | { ok: false; reason: string };

/** `failed` = no usable answer after retries; never cached, so a re-run retries it. */
export type FetchResult =
  | { kind: "measured"; outcome: RouteOutcome }
  | { kind: "failed"; reason: string };

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface RouteDeps {
  fetch: typeof fetch;
  clock: Clock;
  /** Resolves when the next request may start. */
  throttle: () => Promise<void>;
}

/** Total ferry meters across all legs (public OSRM can't exclude ferries). */
export function ferryMeters(route: OsrmRoute): number {
  let m = 0;
  for (const leg of route.legs) for (const s of leg.steps) if (s.mode === "ferry") m += s.distance;
  return m;
}

/** Accept or reject one OSRM answer; accepted routes are simplified + encoded. */
export function evaluateRoute(res: OsrmResponse): RouteOutcome {
  const route = res.routes?.[0];
  if (res.code !== "Ok" || !route) return { ok: false, reason: res.code || "NoCode" };
  if (ferryMeters(route) > MAX_FERRY_M) return { ok: false, reason: "ferry" };
  const coords = simplifyLngLat(route.geometry.coordinates, SIMPLIFY_M);
  if (coords.length < 2) return { ok: false, reason: "EmptyGeometry" };
  const poly = polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
  return { ok: true, route: { m: Math.round(route.distance), poly } };
}

/** `driving` is fixed OSRM URL syntax; the routed-* server picks the profile. */
export function osrmUrl(profile: Profile, dest: LatLon, origin: LatLon = ORIGIN): string {
  return (
    `${OSRM_BASE}/routed-${OSRM_PROFILE[profile]}/route/v1/driving/` +
    `${origin.lon},${origin.lat};${dest.lon},${dest.lat}` +
    "?overview=full&geometries=geojson&steps=true"
  );
}

/** Returns a gate that spaces successive starts at least `gapMs` apart. */
export function makeThrottle(gapMs: number, clock: Clock): () => Promise<void> {
  let last = -Infinity;
  return async () => {
    const wait = last + gapMs - clock.now();
    if (wait > 0) await clock.sleep(wait);
    last = clock.now();
  };
}

/**
 * Measure one profile. 429 / 5xx / timeout / network errors are retried with
 * backoff up to MAX_ATTEMPTS; any other HTTP answer (incl. 400 NoRoute) is a
 * measurement.
 */
export async function fetchRoute(profile: Profile, dest: LatLon, deps: RouteDeps): Promise<FetchResult> {
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.clock.sleep(BACKOFF_BASE_MS * 2 ** (attempt - 2));
    await deps.throttle();
    try {
      const res = await deps.fetch(osrmUrl(profile, dest), {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      return { kind: "measured", outcome: evaluateRoute((await res.json()) as OsrmResponse) };
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }
  return { kind: "failed", reason: lastError };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts && pnpm typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-city-distances.ts scripts/build-city-distances.test.ts
git commit -m "feat: city stage B osrm fetch with ferry check, retry, throttle"
```

---

### Task 4: Stage B — resumable cache and enrichment loop

**Files:**
- Modify: `scripts/build-city-distances.ts` (append)
- Test: `scripts/build-city-distances.test.ts` (append)

**Interfaces:**
- Consumes: `RouteOutcome`, `FetchResult`, `SIMPLIFY_M` (Task 3); `Candidate`, `EncodedCity`, `EncodedCityRoute`, `GeoCity`, `Profile` types.
- Produces:
  - `PROFILES: Profile[]` (`["cycling", "walking"]`)
  - `interface CacheEntry { id: number; profile: Profile; simplifyM: number; outcome: RouteOutcome }`
  - `type RouteCache = Map<string, RouteOutcome>`, `cacheKey(id: number, profile: Profile): string`
  - `parseCache(text: string, simplifyM?: number): RouteCache`
  - `interface EnrichDeps { fetchRoute(profile: Profile, dest: Candidate): Promise<FetchResult>; cache: RouteCache; record(entry: CacheEntry): Promise<void>; log?(msg: string): void }`
  - `interface EnrichStats { candidates: number; kept: number; dropped: number; rejected: Record<Profile, Record<string, number>>; failed: string[] }`
  - `enrich(candidates: Candidate[], deps: EnrichDeps): Promise<{ cities: EncodedCity[]; stats: EnrichStats }>`

- [ ] **Step 1: Append the failing tests**

Append to `scripts/build-city-distances.test.ts`:

```ts
// --- Stage B: cache + enrich -----------------------------------------------

import {
  cacheKey,
  enrich,
  parseCache,
  type CacheEntry,
  type EnrichDeps,
  type FetchResult,
  type RouteOutcome,
} from "./build-city-distances.ts";
import type { Candidate, Profile } from "./city-types.ts";

const okOutcome = (m: number): RouteOutcome => ({ ok: true, route: { m, poly: "_p~iF~ps|U_ulLnnqC" } });
const cand = (id: number): Candidate => ({ ...cityAt(id, 100 * id), gcM: 100_000 * id });

/** EnrichDeps answering from `answers[`${id}:${profile}`]`, recording calls. */
function enrichDeps(answers: Record<string, FetchResult>, cache = new Map<string, RouteOutcome>()) {
  const calls: string[] = [];
  const recorded: CacheEntry[] = [];
  const deps: EnrichDeps = {
    cache,
    fetchRoute: async (profile: Profile, dest: Candidate) => {
      const key = cacheKey(dest.id, profile);
      calls.push(key);
      return answers[key];
    },
    record: async (e) => {
      recorded.push(e);
    },
  };
  return { deps, calls, recorded };
}

test("enrich: both profiles accepted → city kept with both routes and cached", async () => {
  const { deps, recorded } = enrichDeps({
    "1:cycling": { kind: "measured", outcome: okOutcome(153_000) },
    "1:walking": { kind: "measured", outcome: okOutcome(143_000) },
  });
  const { cities, stats } = await enrich([cand(1)], deps);
  assert.equal(cities.length, 1);
  assert.equal(cities[0].cycling?.m, 153_000);
  assert.equal(cities[0].walking?.m, 143_000);
  assert.ok(!("gcM" in cities[0]), "gcM must not leak onto the wire");
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].simplifyM, 500);
  assert.equal(stats.kept, 1);
});

test("enrich: one profile rejected → kept with null, reason counted", async () => {
  const { deps } = enrichDeps({
    "1:cycling": { kind: "measured", outcome: { ok: false, reason: "ferry" } },
    "1:walking": { kind: "measured", outcome: okOutcome(143_000) },
  });
  const { cities, stats } = await enrich([cand(1)], deps);
  assert.equal(cities[0].cycling, null);
  assert.deepEqual(stats.rejected.cycling, { ferry: 1 });
});

test("enrich: both profiles null → city dropped", async () => {
  const { deps } = enrichDeps({
    "1:cycling": { kind: "measured", outcome: { ok: false, reason: "NoRoute" } },
    "1:walking": { kind: "measured", outcome: { ok: false, reason: "ferry" } },
  });
  const { cities, stats } = await enrich([cand(1)], deps);
  assert.equal(cities.length, 0);
  assert.equal(stats.dropped, 1);
});

test("enrich: cache hit makes no call and records nothing", async () => {
  const cache = new Map([
    [cacheKey(1, "cycling"), okOutcome(153_000)],
    [cacheKey(1, "walking"), { ok: false, reason: "ferry" } as RouteOutcome],
  ]);
  const { deps, calls, recorded } = enrichDeps({}, cache);
  const { cities, stats } = await enrich([cand(1)], deps);
  assert.deepEqual(calls, []);
  assert.deepEqual(recorded, []);
  assert.equal(cities[0].cycling?.m, 153_000);
  assert.deepEqual(stats.rejected.walking, { ferry: 1 });
});

test("enrich: a failure is reported and not cached", async () => {
  const { deps, recorded } = enrichDeps({
    "1:cycling": { kind: "failed", reason: "HTTP 503" },
    "1:walking": { kind: "measured", outcome: okOutcome(143_000) },
  });
  const { stats } = await enrich([cand(1)], deps);
  assert.equal(stats.failed.length, 1);
  assert.match(stats.failed[0], /cycling: HTTP 503/);
  assert.deepEqual(recorded.map((e) => e.profile), ["walking"]);
  assert.ok(!deps.cache.has(cacheKey(1, "cycling")));
});

test("parseCache: resumes past a truncated last line from an interrupted run", () => {
  const good: CacheEntry = { id: 1, profile: "cycling", simplifyM: 500, outcome: okOutcome(1) };
  const text = JSON.stringify(good) + "\n" + '{"id":2,"profile":"walk';
  const cache = parseCache(text);
  assert.equal(cache.size, 1);
  assert.ok(cache.has(cacheKey(1, "cycling")));
});

test("parseCache: ignores entries encoded at a different simplify tolerance", () => {
  const stale: CacheEntry = { id: 1, profile: "cycling", simplifyM: 250, outcome: okOutcome(1) };
  assert.equal(parseCache(JSON.stringify(stale) + "\n").size, 0);
});

test("parseCache: later lines win and blank lines are skipped", () => {
  const a: CacheEntry = { id: 1, profile: "cycling", simplifyM: 500, outcome: { ok: false, reason: "NoRoute" } };
  const b: CacheEntry = { ...a, outcome: okOutcome(5) };
  const cache = parseCache(`${JSON.stringify(a)}\n\n${JSON.stringify(b)}\n`);
  assert.deepEqual(cache.get(cacheKey(1, "cycling")), okOutcome(5));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts`
Expected: FAIL — `enrich` / `parseCache` / `cacheKey` not exported.

- [ ] **Step 3: Implement cache + enrich**

Merge `EncodedCity` into the `import type` line from `./city-types.ts`, then append:

```ts
// --- Stage B: cache + enrichment -------------------------------------------

export const PROFILES: Profile[] = ["cycling", "walking"];

/** One line of the gitignored JSONL cache. Measured results only, never failures. */
export interface CacheEntry {
  id: number;
  profile: Profile;
  /** Tolerance the cached poly was encoded at; other values are ignored. */
  simplifyM: number;
  outcome: RouteOutcome;
}

export type RouteCache = Map<string, RouteOutcome>;

export function cacheKey(id: number, profile: Profile): string {
  return `${id}:${profile}`;
}

/** Parse the JSONL cache. Later lines win; unparsable lines are skipped. */
export function parseCache(text: string, simplifyM: number = SIMPLIFY_M): RouteCache {
  const cache: RouteCache = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: CacheEntry;
    try {
      e = JSON.parse(line) as CacheEntry;
    } catch {
      continue; // truncated tail of an interrupted run
    }
    if (e.simplifyM !== simplifyM) continue;
    cache.set(cacheKey(e.id, e.profile), e.outcome);
  }
  return cache;
}

export interface EnrichDeps {
  fetchRoute(profile: Profile, dest: Candidate): Promise<FetchResult>;
  cache: RouteCache;
  /** Persist a fresh measurement (appends to the JSONL cache in main). */
  record(entry: CacheEntry): Promise<void>;
  log?(msg: string): void;
}

export interface EnrichStats {
  candidates: number;
  kept: number;
  /** Cities whose both profiles were rejected. */
  dropped: number;
  /** Per profile: rejection reason → count. */
  rejected: Record<Profile, Record<string, number>>;
  /** Human-readable "<name> (<id>) <profile>: <reason>" per failed request. */
  failed: string[];
}

function toGeo({ id, name, country, lat, lon, population, fc }: Candidate): GeoCity {
  return { id, name, country, lat, lon, population, fc };
}

const fmtKm = (m: number) => `${Math.round(m / 1000)} km`;

/** Stage B: measure every candidate (cache first), sequentially. */
export async function enrich(
  candidates: Candidate[],
  deps: EnrichDeps,
): Promise<{ cities: EncodedCity[]; stats: EnrichStats }> {
  const stats: EnrichStats = {
    candidates: candidates.length,
    kept: 0,
    dropped: 0,
    rejected: { cycling: {}, walking: {} },
    failed: [],
  };
  const cities: EncodedCity[] = [];
  for (const [i, cand] of candidates.entries()) {
    const routes: Record<Profile, EncodedCityRoute | null> = { cycling: null, walking: null };
    const notes: string[] = [];
    let failed = false;
    for (const profile of PROFILES) {
      const key = cacheKey(cand.id, profile);
      let outcome = deps.cache.get(key);
      if (!outcome) {
        const res = await deps.fetchRoute(profile, cand);
        if (res.kind === "failed") {
          stats.failed.push(`${cand.name} (${cand.id}) ${profile}: ${res.reason}`);
          notes.push(`${profile} FAILED`);
          failed = true;
          continue;
        }
        outcome = res.outcome;
        deps.cache.set(key, outcome);
        await deps.record({ id: cand.id, profile, simplifyM: SIMPLIFY_M, outcome });
      }
      if (outcome.ok) {
        routes[profile] = outcome.route;
        notes.push(`${profile} ${fmtKm(outcome.route.m)}`);
      } else {
        const r = stats.rejected[profile];
        r[outcome.reason] = (r[outcome.reason] ?? 0) + 1;
        notes.push(`${profile} ✗ ${outcome.reason}`);
      }
    }
    deps.log?.(`[${i + 1}/${candidates.length}] ${cand.name}, ${cand.country}: ${notes.join(", ")}`);
    if (!routes.cycling && !routes.walking) {
      if (!failed) stats.dropped++;
      continue;
    }
    cities.push({ ...toGeo(cand), ...routes });
    stats.kept++;
  }
  return { cities, stats };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts && pnpm typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-city-distances.ts scripts/build-city-distances.test.ts
git commit -m "feat: city stage B resumable cache + enrich loop"
```

---

### Task 5: Stage C — coverage, sanity warnings, payload and report

**Files:**
- Modify: `scripts/build-city-distances.ts` (append)
- Test: `scripts/build-city-distances.test.ts` (append)

**Interfaces:**
- Consumes: `ORIGIN`, `haversineM` (Task 1); `SIMPLIFY_M`, `PROFILES`, `EnrichStats` (Tasks 3–4); `EncodedCity`, `CityDistancePayload`, `Profile`.
- Produces:
  - `PAYLOAD_VERSION = 1`
  - `coverageTargets(): number[]` (log grid 20 km → 6,000 km, 50 per decade, endpoint included)
  - `coverageHoles(cities: EncodedCity[], profile: Profile, targets?: number[]): number[]`
  - `sanityWarnings(cities: EncodedCity[], origin?: LatLon): string[]`
  - `buildPayload(cities: EncodedCity[], generated: string): CityDistancePayload`
  - `blockingProblems(stats: EnrichStats, holes: Record<Profile, number[]>): string[]` (non-empty → do not write)
  - `formatReport(stats: EnrichStats, payload: CityDistancePayload, json: string, holes: Record<Profile, number[]>, warnings: string[]): string`

- [ ] **Step 1: Append the failing tests**

Append to `scripts/build-city-distances.test.ts`:

```ts
// --- Stage C ---------------------------------------------------------------

import {
  PAYLOAD_VERSION,
  blockingProblems,
  buildPayload,
  coverageHoles,
  coverageTargets,
  formatReport,
  sanityWarnings,
  type EnrichStats,
} from "./build-city-distances.ts";
import type { EncodedCity } from "./city-types.ts";

function encCity(id: number, cyclingKm: number | null, walkingKm: number | null = null, at = 100): EncodedCity {
  const route = (km: number | null) => (km === null ? null : { m: km * 1000, poly: "" });
  return { ...cityAt(id, at), cycling: route(cyclingKm), walking: route(walkingKm) };
}

/** Cities at 20 km × 1.5^k up to ~5,800 km: every target within ±40 % of one. */
const LADDER = Array.from({ length: 15 }, (_, k) => encCity(k + 1, 20 * 1.5 ** k));

const emptyStats = (): EnrichStats => ({
  candidates: 0, kept: 0, dropped: 0, rejected: { cycling: {}, walking: {} }, failed: [],
});

test("coverageTargets: 20 km to 6,000 km inclusive, ~50 per decade", () => {
  const t = coverageTargets();
  assert.equal(t[0], 20_000);
  assert.equal(t[t.length - 1], 6_000_000);
  assert.ok(t.length >= 124 && t.length <= 126, `got ${t.length}`);
});

test("coverageHoles: full coverage passes", () => {
  assert.deepEqual(coverageHoles(LADDER, "cycling"), []);
});

test("coverageHoles: a gap fails, reporting targets inside it", () => {
  const gapped = LADDER.filter((c) => {
    const km = c.cycling!.m / 1000;
    return km < 300 || km > 1500;
  });
  const holes = coverageHoles(gapped, "cycling");
  assert.ok(holes.length > 0);
  assert.ok(holes.every((m) => m > 300_000 && m < 1_500_000 * 1.4));
});

test("coverageHoles: checked per profile", () => {
  assert.equal(coverageHoles(LADDER, "walking").length, coverageTargets().length);
});

test("sanityWarnings: route shorter than great-circle, and > 3x detour", () => {
  // cityAt(_, 117) is 117 km great-circle from the origin.
  const w = sanityWarnings([
    encCity(1, 100, null, 117), // shorter → warn
    encCity(2, 400, null, 117), // > 351 km → warn
    encCity(3, 153, 143, 117), // fine
  ]);
  assert.equal(w.length, 2);
  assert.match(w[0], /C1.*cycling.*great-circle/);
  assert.match(w[1], /C2.*cycling.*detour/);
});

test("buildPayload: header fields and cycling-asc order, null cycling last", () => {
  const p = buildPayload([encCity(1, 300), encCity(2, null, 50), encCity(3, 100)], "2026-10-04");
  assert.equal(p.v, PAYLOAD_VERSION);
  assert.equal(p.router, "osrm-fossgis");
  assert.equal(p.simplifyM, 500);
  assert.equal(p.generated, "2026-10-04");
  assert.deepEqual(p.origin, { name: "Ljubljana", lat: 46.0569, lon: 14.5058 });
  assert.deepEqual(p.cities.map((c) => c.id), [3, 1, 2]);
});

test("blockingProblems: failures and holes block the write; clean run doesn't", () => {
  assert.deepEqual(blockingProblems(emptyStats(), { cycling: [], walking: [] }), []);
  const failed = { ...emptyStats(), failed: ["Zagreb (1) cycling: HTTP 503"] };
  assert.equal(blockingProblems(failed, { cycling: [], walking: [] }).length, 1);
  assert.equal(blockingProblems(emptyStats(), { cycling: [400_000], walking: [] }).length, 1);
});

test("formatReport: lists counts, rejections, range and size", () => {
  const stats = { ...emptyStats(), candidates: 3, kept: 2, rejected: { cycling: { ferry: 2 }, walking: {} } };
  const p = buildPayload([encCity(1, 100, 90), encCity(2, 2500, 2400)], "2026-10-04");
  const out = formatReport(stats, p, JSON.stringify(p), { cycling: [], walking: [] }, []);
  assert.match(out, /candidates 3/);
  assert.match(out, /kept 2/);
  assert.match(out, /ferry: 2/);
  assert.match(out, /100 km .. 2500 km/);
  assert.match(out, /gz/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts`
Expected: FAIL — stage C functions not exported.

- [ ] **Step 3: Implement stage C**

Add `import { gzipSync } from "node:zlib";` at the top and merge `CityDistancePayload` into the `import type` line. Append:

```ts
// --- Stage C: validation + output ------------------------------------------

/** Wire-format version written to city-distances.json (see app/src/cities.ts). */
export const PAYLOAD_VERSION = 1;
const COVERAGE_MIN_M = 20_000;
const COVERAGE_MAX_M = 6_000_000;
const COVERAGE_PER_DECADE = 50;
/** A target is covered by a city whose route m is within ±this fraction. */
const COVERAGE_TOL = 0.4;
/** Route longer than this × great-circle is reported as a strange detour. */
const DETOUR_FACTOR = 3;

/** Log grid of target distances the dataset must cover. */
export function coverageTargets(): number[] {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const t = COVERAGE_MIN_M * 10 ** (i / COVERAGE_PER_DECADE);
    if (t >= COVERAGE_MAX_M) break;
    out.push(t);
  }
  out.push(COVERAGE_MAX_M);
  return out;
}

/** Targets with no city within ±COVERAGE_TOL — where pickCity would fall back. */
export function coverageHoles(
  cities: EncodedCity[],
  profile: Profile,
  targets: number[] = coverageTargets(),
): number[] {
  const ms = cities.flatMap((c) => (c[profile] ? [c[profile]!.m] : []));
  return targets.filter((t) => !ms.some((m) => Math.abs(m - t) <= COVERAGE_TOL * t));
}

/** Non-fatal oddities: impossible (bad geocode) or strangely long routes. */
export function sanityWarnings(cities: EncodedCity[], origin: LatLon = ORIGIN): string[] {
  const out: string[] = [];
  for (const c of cities) {
    const gc = haversineM(origin, c);
    for (const profile of PROFILES) {
      const route = c[profile];
      if (!route) continue;
      const who = `${c.name}, ${c.country} (${c.id}) ${profile}`;
      if (route.m < gc) out.push(`${who}: route ${fmtKm(route.m)} < great-circle ${fmtKm(gc)}`);
      else if (route.m > DETOUR_FACTOR * gc)
        out.push(`${who}: route ${fmtKm(route.m)} > ${DETOUR_FACTOR}x great-circle ${fmtKm(gc)} (detour)`);
    }
  }
  return out;
}

/** Wire payload; cities sorted by cycling.m asc with cycling: null last. */
export function buildPayload(cities: EncodedCity[], generated: string): CityDistancePayload {
  // Infinity - Infinity is NaN, which is falsy, so ties fall through to the next key.
  const sorted = [...cities].sort(
    (a, b) =>
      (a.cycling?.m ?? Infinity) - (b.cycling?.m ?? Infinity) ||
      (a.walking?.m ?? Infinity) - (b.walking?.m ?? Infinity) ||
      a.id - b.id,
  );
  return {
    v: PAYLOAD_VERSION,
    generated,
    router: "osrm-fossgis",
    simplifyM: SIMPLIFY_M,
    origin: { name: ORIGIN.name, lat: ORIGIN.lat, lon: ORIGIN.lon },
    cities: sorted,
  };
}

/** Reasons not to write the output. Empty → safe to write. */
export function blockingProblems(stats: EnrichStats, holes: Record<Profile, number[]>): string[] {
  const out: string[] = [];
  if (stats.failed.length)
    out.push(`${stats.failed.length} request(s) failed; re-run to retry them (measured results are cached).`);
  for (const profile of PROFILES)
    if (holes[profile].length)
      out.push(`${profile}: coverage holes at ${holes[profile].map(fmtKm).join(", ")}; tune stage A.`);
  return out;
}

export function formatReport(
  stats: EnrichStats,
  payload: CityDistancePayload,
  json: string,
  holes: Record<Profile, number[]>,
  warnings: string[],
): string {
  const lines = [
    `candidates ${stats.candidates}, kept ${stats.kept}, dropped ${stats.dropped}, failed ${stats.failed.length}`,
  ];
  for (const profile of PROFILES) {
    const ms = payload.cities.flatMap((c) => (c[profile] ? [c[profile]!.m] : []));
    const rejected = Object.entries(stats.rejected[profile]).map(([r, n]) => `${r}: ${n}`).join(", ") || "none";
    const range = ms.length ? `${fmtKm(Math.min(...ms))} .. ${fmtKm(Math.max(...ms))}` : "—";
    lines.push(`${profile}: ${ms.length} routes, ${range}; rejected ${rejected}; holes ${holes[profile].length}`);
  }
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  lines.push(`size ${kb(Buffer.byteLength(json))} raw / ${kb(gzipSync(json).length)} gz`);
  for (const f of stats.failed) lines.push(`FAILED ${f}`);
  for (const w of warnings) lines.push(`WARN ${w}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test scripts/build-city-distances.test.ts && pnpm typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-city-distances.ts scripts/build-city-distances.test.ts
git commit -m "feat: city stage C coverage, sanity, payload, report"
```

---

### Task 6: `main()`, CLI flags, and project wiring

**Files:**
- Modify: `scripts/build-city-distances.ts` (append `main()` + direct-run guard)
- Modify: `package.json` (add `build:cities`)
- Modify: `.gitignore` (cache file)
- Modify: `README.md` (regeneration section)

**Interfaces:**
- Consumes: everything exported by Tasks 1, 3, 4, 5.
- Produces: `pnpm run build:cities [--fresh] [--dry-run]`.

- [ ] **Step 1: Append `main()`**

Add `import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";`, `import { dirname, resolve } from "node:path";`, `import { fileURLToPath } from "node:url";` to the top imports, then append:

```ts
// --- main ------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEONAMES_PATH = resolve(__dirname, "data/geonames-cities.json");
const CACHE_PATH = resolve(__dirname, "data/.city-distances-cache.jsonl");
const OUT_PATH = resolve(__dirname, "../app/public/city-distances.json");

async function readCacheText(): Promise<string> {
  try {
    return await readFile(CACHE_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const geo = JSON.parse(await readFile(GEONAMES_PATH, "utf8")) as GeoCity[];
  const candidates = selectCandidates(geo);
  console.log(`Stage A: ${candidates.length} candidates from ${geo.length} cities.`);

  if (args.has("--dry-run")) {
    const perBucket = new Map<number, string[]>();
    for (const c of candidates) {
      const b = bucketIndex(c.gcM)!;
      perBucket.set(b, [...(perBucket.get(b) ?? []), c.name]);
    }
    for (const [b, names] of [...perBucket].sort((x, y) => x[0] - y[0]))
      console.log(`${fmtKm(bucketLowerM(b)).padStart(9)}  ${names.length}  ${names.join(", ")}`);
    return;
  }

  if (args.has("--fresh")) await writeFile(CACHE_PATH, "");
  const cache = parseCache(await readCacheText());
  const todo = candidates.length * PROFILES.length -
    candidates.reduce((n, c) => n + PROFILES.filter((p) => cache.has(cacheKey(c.id, p))).length, 0);
  console.log(`Stage B: ${todo} OSRM requests to make (~${Math.ceil(todo / 60)} min at 1 req/s).`);

  const deps: RouteDeps = { fetch, clock: realClock, throttle: makeThrottle(MIN_REQUEST_GAP_MS, realClock) };
  const { cities, stats } = await enrich(candidates, {
    fetchRoute: (profile, dest) => fetchRoute(profile, dest, deps),
    cache,
    record: (e) => appendFile(CACHE_PATH, JSON.stringify(e) + "\n"),
    log: (msg) => console.log(msg),
  });

  const payload = buildPayload(cities, new Date().toISOString().slice(0, 10));
  const json = JSON.stringify(payload);
  const holes = { cycling: coverageHoles(cities, "cycling"), walking: coverageHoles(cities, "walking") };
  console.log("\nStage C:\n" + formatReport(stats, payload, json, holes, sanityWarnings(cities)));

  const problems = blockingProblems(stats, holes);
  if (problems.length) {
    for (const p of problems) console.error(`ERROR ${p}`);
    console.error(`Not writing ${OUT_PATH}.`);
    process.exit(1);
  }
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, json);
  console.log(`Wrote ${payload.cities.length} cities to ${OUT_PATH}.`);
}

// Only run when executed directly, so tests can import the stages without I/O.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Wire `package.json` and `.gitignore`**

In `package.json` `scripts`, after `"build:icons"` add (do **not** add it to `build`):

```json
    "build:cities": "tsx scripts/build-city-distances.ts",
```

Append to `.gitignore`:

```
# Resumable OSRM measurement cache for build:cities (the output JSON is committed).
scripts/data/.city-distances-cache.jsonl
```

- [ ] **Step 3: Document regeneration in `README.md`**

Add a section after "## Live Garmin fetch" (before "## Config"):

````markdown
## City distance comparisons

`app/public/city-distances.json` holds ~500 cities with real bike and foot
route distances (and simplified route lines) from Ljubljana, used to say
"you rode 2,500 km — that's Ljubljana → Lisbon". It is network-derived, so it
is **committed** and not rebuilt by `pnpm run build`.

To regenerate (rare):

```bash
# optional: refresh the vendored GeoNames subset
curl -L -o /tmp/cities15000.zip https://download.geonames.org/export/dump/cities15000.zip
unzip -o /tmp/cities15000.zip -d /tmp
pnpm exec tsx scripts/prepare-geonames.ts /tmp/cities15000.txt

pnpm run build:cities --dry-run   # stage A only: candidates per distance bucket
pnpm run build:cities             # ~18 min; resumable, re-run after an interruption
pnpm run build:cities --fresh     # ignore the measurement cache
```

Routes come from the public FOSSGIS OSRM server
(`routing.openstreetmap.de`). The script follows its usage policy: one
request at a time, at most 1 request/second, an identifying User-Agent, and
only as an occasional one-off build — the app itself never calls it. The
script refuses to write the file if any request failed or a distance range
between 20 km and 6,000 km has no city within ±40 %.
````

- [ ] **Step 4: Verify typecheck, tests, and a dry run**

```bash
pnpm typecheck && pnpm test && pnpm run build:cities --dry-run | head -20
```

Expected: typecheck clean; all script tests pass; dry run prints "Stage A: N candidates" and per-bucket lines starting at ~20 km. No network access happens.

- [ ] **Step 5: One live smoke request (manual, optional)**

Run: `curl -s -A 'strava-on-maps-build (https://github.com/jakaskerjanc/strava-on-maps)' 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/14.5058,46.0569;15.9819,45.815?overview=false' | head -c 300`
Expected: JSON with `"code":"Ok"` and a distance near 153,000. (Confirms the server is reachable before the long run in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add scripts/build-city-distances.ts package.json .gitignore README.md
git commit -m "feat: build:cities script entrypoint + docs"
```

---

### Task 7: Generate and commit `city-distances.json`

**Files:**
- Create (generated): `app/public/city-distances.json`

**Interfaces:**
- Consumes: `pnpm run build:cities` (Task 6).
- Produces: the committed dataset that Tasks 8–10 can be checked against.

- [ ] **Step 1: Run the full build (network, ~18 min)**

Run in the background and wait for it to exit: `pnpm run build:cities 2>&1 | tee /tmp/build-cities.log`
Expected: per-city progress lines, then a "Stage C:" report and "Wrote N cities". If it is interrupted, just re-run the same command — it resumes from the cache.

- [ ] **Step 2: Handle a failed stage C**

- `ERROR … request(s) failed` → re-run `pnpm run build:cities` (only the failures are re-requested).
- `ERROR … coverage holes at …` → run `pnpm run build:cities --dry-run`, look at the buckets around the hole, and either lower `POP_FLOOR_ANCHORS` near that distance or raise `K_NEAR` in `scripts/build-city-distances.ts`. Re-run; only new candidates are measured. Commit the constant change together with the dataset and mention it in the message.

- [ ] **Step 3: Review the report**

Check in `/tmp/build-cities.log`:
- kept ≈ 500, rejected counts plausible (Reykjavík-style ferries, a few `NoRoute`);
- min cycling/walking ≈ 20–30 km, max ≈ 10,000+ km;
- size within ~0.8–2.5 MB raw / ~0.5–1.5 MB gz (spec estimate 1.7 MB / 1.0 MB ±50 %);
- skim the `WARN` lines; they don't block, but obvious geocode errors (a city routed to the wrong country) are worth removing by tightening stage A.

Spot-check a few known values:

```bash
node -e 'const p=require("./app/public/city-distances.json");for(const n of ["Zagreb","Prague","Paris","Lisbon"]){const c=p.cities.find(x=>x.name===n);console.log(n,c&&c.cycling&&c.cycling.m,c&&c.walking&&c.walking.m)}'
```

Expected (within a few %): Zagreb ~153 km / ~143 km, Prague ~560 / ~568 km, Paris ~1,329 / ~1,219 km, Lisbon ~2,818 / ~2,655 km (any not selected by stage A print `undefined`; that is fine).

- [ ] **Step 4: Commit**

```bash
git add app/public/city-distances.json
git commit -m "data: city-distances.json from osrm-fossgis"
```

---

### Task 8: App — wire types, `decodeCities`, `loadCities`

**Files:**
- Modify: `app/src/types.ts` (append the city wire types)
- Create: `app/src/cities.ts`
- Test: `app/src/cities.test.ts`

**Interfaces:**
- Consumes: wire shape from `scripts/city-types.ts` (copied, not imported).
- Produces:
  - in `app/src/types.ts`: `Profile`, `EncodedCityRoute`, `EncodedCity`, `CityDistancePayload`
  - in `app/src/cities.ts`: `CITY_PAYLOAD_VERSION = 1`, `interface CityRoute { m: number; coords: [number, number][] }`, `interface CityDistance { id; name; country; fc; lat; lon; population; cycling: CityRoute | null; walking: CityRoute | null }`, `decodeCities(payload: CityDistancePayload): CityDistance[]`, `loadCities(signal?: AbortSignal): Promise<CityDistance[]>`

- [ ] **Step 1: Append the app copy of the wire types**

Append to `app/src/types.ts`:

```ts
// --- City distance comparisons ---------------------------------------------
// Frontend copy of the city-distances.json wire format.
// Keep in sync with scripts/city-types.ts (the encoder side).

/** Comparison group; also the per-city route key in city-distances.json. */
export type Profile = "cycling" | "walking";

export interface EncodedCityRoute {
  /** OSRM route distance, meters */
  m: number;
  /** Google-encoded polyline of the route, [lat,lng] precision-5. */
  poly: string;
}

export interface EncodedCity {
  /** GeoNames geonameid */
  id: number;
  name: string;
  /** ISO 3166-1 alpha-2 */
  country: string;
  /** GeoNames feature code: PPLC national capital, PPLA regional capital, PPL… */
  fc: string;
  lat: number;
  lon: number;
  population: number;
  cycling: EncodedCityRoute | null;
  walking: EncodedCityRoute | null;
}

/** Root shape of app/public/city-distances.json. */
export interface CityDistancePayload {
  /** Wire-format version, bumped on breaking shape changes. */
  v: number;
  generated: string;
  router: string;
  simplifyM: number;
  origin: { name: string; lat: number; lon: number };
  cities: EncodedCity[];
}
```

- [ ] **Step 2: Write the failing tests**

`app/src/cities.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from "vitest";
import polyline from "@mapbox/polyline";
import { CITY_PAYLOAD_VERSION, decodeCities, loadCities } from "./cities";
import type { CityDistancePayload, EncodedCity } from "./types";

/** Encode a [lng, lat] path the way scripts/build-city-distances.ts does. */
function encodeLngLat(coords: [number, number][]): string {
  return polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
}

const PATH: [number, number][] = [
  [14.5058, 46.0569],
  [15.2, 45.95],
  [15.9819, 45.815],
];

function city(over: Partial<EncodedCity> = {}): EncodedCity {
  return {
    id: 3186886, name: "Zagreb", country: "HR", fc: "PPLC",
    lat: 45.815, lon: 15.9819, population: 698966,
    cycling: { m: 153000, poly: encodeLngLat(PATH) },
    walking: null,
    ...over,
  };
}

function payload(cities: EncodedCity[], v = CITY_PAYLOAD_VERSION): CityDistancePayload {
  return {
    v, generated: "2026-10-04", router: "osrm-fossgis", simplifyM: 500,
    origin: { name: "Ljubljana", lat: 46.0569, lon: 14.5058 }, cities,
  };
}

describe("decodeCities", () => {
  test("decodes polylines to [lng, lat] and keeps scalar fields", () => {
    const [c] = decodeCities(payload([city()]));
    expect(c.name).toBe("Zagreb");
    expect(c.fc).toBe("PPLC");
    expect(c.cycling?.m).toBe(153000);
    expect(c.cycling?.coords).toHaveLength(3);
    c.cycling!.coords.forEach(([lng, lat], i) => {
      expect(lng).toBeCloseTo(PATH[i][0], 5);
      expect(lat).toBeCloseTo(PATH[i][1], 5);
    });
  });

  test("preserves null profiles", () => {
    const [c] = decodeCities(payload([city()]));
    expect(c.walking).toBeNull();
  });

  test("a degenerate (< 2 point) route decodes to null", () => {
    const [c] = decodeCities(payload([city({ walking: { m: 1, poly: encodeLngLat([PATH[0]]) } })]));
    expect(c.walking).toBeNull();
  });

  test("rejects an unknown payload version", () => {
    expect(() => decodeCities(payload([city()], 99))).toThrow(/version 99/);
  });
});

describe("loadCities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches city-distances.json from the base URL and decodes it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload([city()]))));
    vi.stubGlobal("fetch", fetchMock);
    const cities = await loadCities();
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}city-distances.json`, { signal: undefined });
    expect(cities[0].cycling?.coords).toHaveLength(3);
  });

  test("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    await expect(loadCities()).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter app exec vitest run src/cities.test.ts`
Expected: FAIL — cannot resolve `./cities`.

- [ ] **Step 4: Implement**

`app/src/cities.ts`:

```ts
// Load the precomputed city-distances.json (built offline by
// scripts/build-city-distances.ts) and decode each route once into [lng, lat]
// coordinates a map layer can draw directly. Not imported at startup — the UI
// decides when to call loadCities(). Keep in sync with the encoder side.

import polyline from "@mapbox/polyline";
import type { CityDistancePayload, EncodedCityRoute } from "./types";

/** Wire-format version this decoder understands (see scripts/build-city-distances.ts). */
export const CITY_PAYLOAD_VERSION = 1;

const CITIES_URL = `${import.meta.env.BASE_URL}city-distances.json`;

export interface CityRoute {
  /** route distance, meters */
  m: number;
  /** [lng, lat] */
  coords: [number, number][];
}

export interface CityDistance {
  id: number;
  name: string;
  country: string;
  fc: string;
  lat: number;
  lon: number;
  population: number;
  cycling: CityRoute | null;
  walking: CityRoute | null;
}

function decodeRoute(route: EncodedCityRoute | null): CityRoute | null {
  if (!route) return null;
  // @mapbox/polyline decodes to [lat, lng]; GeoJSON needs [lng, lat].
  const coords = polyline.decode(route.poly).map(([lat, lng]) => [lng, lat] as [number, number]);
  // A drawable line needs >= 2 points; treat a corrupt route as missing.
  return coords.length < 2 ? null : { m: route.m, coords };
}

/** Expand a city-distances.json payload. Throws on an unknown version. */
export function decodeCities(payload: CityDistancePayload): CityDistance[] {
  if (payload.v !== CITY_PAYLOAD_VERSION) {
    throw new Error(
      `Unsupported city-distances payload version ${payload.v} (expected ${CITY_PAYLOAD_VERSION})`,
    );
  }
  return payload.cities.map(({ cycling, walking, ...city }) => ({
    ...city,
    cycling: decodeRoute(cycling),
    walking: decodeRoute(walking),
  }));
}

/** Fetch + decode the dataset (~1 MB gz); call lazily. */
export async function loadCities(signal?: AbortSignal): Promise<CityDistance[]> {
  const r = await fetch(CITIES_URL, { signal });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return decodeCities((await r.json()) as CityDistancePayload);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter app exec vitest run src/cities.test.ts && pnpm --filter app exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Check the real dataset's version (if Task 7 is done)**

Run: `node -e 'const p=require("./app/public/city-distances.json");console.log(p.v,p.cities.length)'`
Expected: `1 <N>` — matches `CITY_PAYLOAD_VERSION`.

- [ ] **Step 7: Commit**

```bash
git add app/src/types.ts app/src/cities.ts app/src/cities.test.ts
git commit -m "feat: app loadCities + decode for city distances"
```

---

### Task 9: App — `activityGroup`, `groupTotals`, `seededRng`

**Files:**
- Create: `app/src/cityMatch.ts`
- Test: `app/src/cityMatch.test.ts`

**Interfaces:**
- Consumes: `isFootBased` from `app/src/format.ts`; `ActivityFeature`, `Profile` from `app/src/types.ts`.
- Produces: `activityGroup(type: string): Profile | null`, `groupTotals(features: ActivityFeature[]): Record<Profile, number>` (meters), `seededRng(profile: Profile, totalM: number): () => number` (values in [0, 1)).

- [ ] **Step 1: Write the failing tests**

`app/src/cityMatch.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { activityGroup, groupTotals, seededRng } from "./cityMatch";
import type { ActivityFeature } from "./types";

function feature(type: string, distance: number): ActivityFeature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[14.5, 46], [14.6, 46.1]] },
    properties: {
      id: `s:${type}${distance}`, name: type, type, ts: 0, start_date: "",
      distance, moving_time: 0, elevation_gain: 0,
    },
  };
}

describe("activityGroup", () => {
  test.each(["Ride", "EBikeRide", "GravelRide", "MountainBikeRide"])("%s → cycling", (t) => {
    expect(activityGroup(t)).toBe("cycling");
  });
  test.each(["Run", "TrailRun", "Walk", "Hike"])("%s → walking", (t) => {
    expect(activityGroup(t)).toBe("walking");
  });
  test.each(["VirtualRide", "VirtualRun", "Workout", "Swim"])("%s → null", (t) => {
    expect(activityGroup(t)).toBeNull();
  });
});

describe("groupTotals", () => {
  test("sums meters per group and ignores excluded types", () => {
    const totals = groupTotals([
      feature("Ride", 40_000),
      feature("GravelRide", 10_000),
      feature("Run", 8_000),
      feature("Hike", 12_000),
      feature("VirtualRide", 30_000),
      feature("Swim", 2_000),
    ]);
    expect(totals).toEqual({ cycling: 50_000, walking: 20_000 });
  });

  test("empty input → zeros", () => {
    expect(groupTotals([])).toEqual({ cycling: 0, walking: 0 });
  });
});

describe("seededRng", () => {
  const take = (rng: () => number, n = 5) => Array.from({ length: n }, rng);

  test("same profile + km gives the same sequence in [0, 1)", () => {
    const a = take(seededRng("cycling", 2_500_400));
    const b = take(seededRng("cycling", 2_500_100)); // same km after rounding
    expect(a).toEqual(b);
    a.forEach((x) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    });
  });

  test("a different total or profile gives a different sequence", () => {
    const base = take(seededRng("cycling", 2_500_000));
    expect(take(seededRng("cycling", 2_501_000))).not.toEqual(base);
    expect(take(seededRng("walking", 2_500_000))).not.toEqual(base);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter app exec vitest run src/cityMatch.test.ts`
Expected: FAIL — cannot resolve `./cityMatch`.

- [ ] **Step 3: Implement**

`app/src/cityMatch.ts`:

```ts
// Pure helpers that turn activity distance totals into a comparison city
// ("you rode X km — that's Ljubljana → Y"). No React / Mapbox deps.
// See docs/2026-09-19-distance-city-comparison-design.md.

import { isFootBased } from "./format";
import type { ActivityFeature, Profile } from "./types";

/** Which comparison an activity feeds; null = not a distance on the ground. */
export function activityGroup(type: string): Profile | null {
  if (/^virtual/i.test(type)) return null; // indoor trainer / treadmill
  if (/ride/i.test(type)) return "cycling";
  if (isFootBased(type)) return "walking";
  return null;
}

/** Total meters per group for whatever feature set the caller passes. */
export function groupTotals(features: ActivityFeature[]): Record<Profile, number> {
  const totals: Record<Profile, number> = { cycling: 0, walking: 0 };
  for (const f of features) {
    const group = activityGroup(f.properties.type);
    if (group) totals[group] += f.properties.distance;
  }
  return totals;
}

/** FNV-1a 32-bit string hash. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, good-enough PRNG for picking a city. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic RNG seeded from the profile and the total rounded to the km:
 * the same filter always picks the same city; a different total may not.
 */
export function seededRng(profile: Profile, totalM: number): () => number {
  return mulberry32(hashString(`${profile}:${Math.round(totalM / 1000)}`));
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter app exec vitest run src/cityMatch.test.ts && pnpm --filter app exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/cityMatch.ts app/src/cityMatch.test.ts
git commit -m "feat: activity grouping, totals, seeded rng for city match"
```

---

### Task 10: App — `pickCity`

**Files:**
- Modify: `app/src/cityMatch.ts` (append)
- Test: `app/src/cityMatch.test.ts` (append)

**Interfaces:**
- Consumes: `CityDistance`, `CityRoute` from `app/src/cities.ts` (Task 8); `Profile`; `seededRng` (Task 9).
- Produces:
  - `type CityPick = { kind: "match"; city: CityDistance; route: CityRoute; ratio: number } | { kind: "over"; farthest: CityDistance; route: CityRoute } | { kind: "under"; nearest: CityDistance; route: CityRoute }` (`ratio = targetM / route.m`)
  - `BAND = 0.05`, `MAX_BAND = 0.4`
  - `pickCity(cities: CityDistance[], targetM: number, profile: Profile, rng?: () => number): CityPick` — throws if no city has a route for `profile`.

- [ ] **Step 1: Append the failing tests**

Append to `app/src/cityMatch.test.ts`:

```ts
import { pickCity } from "./cityMatch";
import type { CityDistance } from "./cities";

function c(
  id: number,
  cyclingKm: number | null,
  over: Partial<Omit<CityDistance, "cycling">> = {},
): CityDistance {
  return {
    id, name: `C${id}`, country: "XX", fc: "PPL", lat: 0, lon: 0, population: 100,
    cycling: cyclingKm === null ? null : { m: cyclingKm * 1000, coords: [[0, 0], [1, 1]] },
    walking: null,
    ...over,
  };
}

const first = () => 0;
const km = (n: number) => n * 1000;

describe("pickCity", () => {
  test("in-band match with its ratio", () => {
    const pick = pickCity([c(1, 100), c(2, 150), c(3, 200)], km(152), "cycling", first);
    expect(pick).toMatchObject({ kind: "match", city: { id: 2 } });
    if (pick.kind === "match") expect(pick.ratio).toBeCloseTo(152 / 150);
  });

  test("widens the band progressively (5 → 10 → 20 %)", () => {
    // ±5 % and ±10 % of 120 km are empty; ±20 % reaches 100 km but not 200 km.
    const pick = pickCity([c(1, 100), c(2, 200)], km(120), "cycling", first);
    expect(pick).toMatchObject({ kind: "match", city: { id: 1 } });
  });

  test("in-range gap → closest by log ratio, not by absolute distance", () => {
    // 400 km: nothing within ±40 %. |log(1000/400)| < |log(100/400)|.
    const pick = pickCity([c(1, 100), c(2, 1000)], km(400), "cycling", first);
    expect(pick).toMatchObject({ kind: "match", city: { id: 2 } });
    if (pick.kind === "match") expect(pick.ratio).toBeCloseTo(0.4);
  });

  test("beyond the farthest city (+40 %) → over", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    expect(pickCity(cities, km(15_000), "cycling", first)).toMatchObject({ kind: "over", farthest: { id: 2 } });
    expect(pickCity(cities, km(13_000), "cycling", first)).toMatchObject({ kind: "match", city: { id: 2 } });
  });

  test("short of the nearest city (−40 %) → under", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    expect(pickCity(cities, km(10), "cycling", first)).toMatchObject({ kind: "under", nearest: { id: 1 } });
  });

  test("zero or negative total → under, never a 0/NaN ratio match", () => {
    const cities = [c(1, 20), c(2, 10_000)];
    expect(pickCity(cities, 0, "cycling", first).kind).toBe("under");
    expect(pickCity(cities, -5, "cycling", first).kind).toBe("under");
    expect(pickCity(cities, Number.NaN, "cycling", first).kind).toBe("under");
  });

  test("capitals weigh 2x population", () => {
    // Weights 100 | 200 → rng 0.4 lands at 120, inside the capital's share.
    const cities = [c(1, 100), c(2, 101, { fc: "PPLC" })];
    expect(pickCity(cities, km(100.5), "cycling", () => 0.4)).toMatchObject({ city: { id: 2 } });
    // Control: without the boost (100 | 100) the same rng lands at 80 → city 1.
    expect(pickCity([c(1, 100), c(2, 101)], km(100.5), "cycling", () => 0.4)).toMatchObject({ city: { id: 1 } });
  });

  test("regional capitals weigh 1.5x population", () => {
    // Weights 100 | 150 → rng 0.42 lands at 105 → city 2; control lands at 84 → city 1.
    const cities = [c(1, 100), c(2, 101, { fc: "PPLA" })];
    expect(pickCity(cities, km(100.5), "cycling", () => 0.42)).toMatchObject({ city: { id: 2 } });
    expect(pickCity([c(1, 100), c(2, 101)], km(100.5), "cycling", () => 0.42)).toMatchObject({ city: { id: 1 } });
  });

  test("profile isolation: cities without a route for the profile are ignored", () => {
    const bikeOnly = c(1, 100);
    const footOnly = c(2, null, { walking: { m: km(100), coords: [[0, 0], [1, 1]] } });
    expect(pickCity([bikeOnly, footOnly], km(100), "walking", first)).toMatchObject({ city: { id: 2 } });
    expect(pickCity([bikeOnly, footOnly], km(100), "cycling", first)).toMatchObject({ city: { id: 1 } });
  });

  test("throws when no city has a route for the profile", () => {
    expect(() => pickCity([c(1, 100)], km(100), "walking", first)).toThrow(/walking/);
  });

  test("seeded rng makes the pick reproducible", () => {
    const cities = Array.from({ length: 10 }, (_, i) => c(i + 1, 100 + i, { population: 100 + i * 50 }));
    const a = pickCity(cities, km(104), "cycling", seededRng("cycling", km(104)));
    const b = pickCity(cities, km(104), "cycling", seededRng("cycling", km(104)));
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter app exec vitest run src/cityMatch.test.ts`
Expected: FAIL — `pickCity` is not exported.

- [ ] **Step 3: Implement**

Add to the imports in `app/src/cityMatch.ts`:

```ts
import type { CityDistance, CityRoute } from "./cities";
```

Append:

```ts
// --- Picking a city ---------------------------------------------------------

export type CityPick =
  /** ratio = targetM / route.m */
  | { kind: "match"; city: CityDistance; route: CityRoute; ratio: number }
  /** target beyond the farthest city */
  | { kind: "over"; farthest: CityDistance; route: CityRoute }
  /** target short of the nearest city */
  | { kind: "under"; nearest: CityDistance; route: CityRoute };

/** Initial match band (±fraction of the target), doubled until MAX_BAND. */
export const BAND = 0.05;
export const MAX_BAND = 0.4;
const CAPITAL_WEIGHT = 2;
const REGIONAL_CAPITAL_WEIGHT = 1.5;

interface Candidate {
  city: CityDistance;
  route: CityRoute;
}

function weight(city: CityDistance): number {
  return (
    Math.max(city.population, 1) *
    (city.fc === "PPLC" ? CAPITAL_WEIGHT : 1) *
    (city.fc === "PPLA" ? REGIONAL_CAPITAL_WEIGHT : 1)
  );
}

function weightedPick(items: Candidate[], rng: () => number): Candidate {
  const total = items.reduce((sum, it) => sum + weight(it.city), 0);
  let r = rng() * total;
  for (const it of items) {
    r -= weight(it.city);
    if (r < 0) return it;
  }
  return items[items.length - 1]; // rng() rounding at the top edge
}

/**
 * Pick a recognizable city about `targetM` away by `profile`, weighted towards
 * bigger cities and capitals. `kind` tells the caller which case applies.
 */
export function pickCity(
  cities: CityDistance[],
  targetM: number,
  profile: Profile,
  rng: () => number = Math.random,
): CityPick {
  const pool: Candidate[] = cities
    .flatMap((city) => {
      const route = city[profile];
      return route ? [{ city, route }] : [];
    })
    .sort((a, b) => a.route.m - b.route.m || a.city.id - b.city.id);
  if (pool.length === 0) throw new Error(`No cities with a ${profile} route`);

  const nearest = pool[0];
  const farthest = pool[pool.length - 1];
  if (!(targetM > 0) || targetM < nearest.route.m * (1 - MAX_BAND))
    return { kind: "under", nearest: nearest.city, route: nearest.route };
  if (targetM > farthest.route.m * (1 + MAX_BAND))
    return { kind: "over", farthest: farthest.city, route: farthest.route };

  for (let band = BAND; band <= MAX_BAND + 1e-9; band *= 2) {
    const inBand = pool.filter(({ route }) => Math.abs(route.m - targetM) <= band * targetM);
    if (inBand.length > 0) {
      const { city, route } = weightedPick(inBand, rng);
      return { kind: "match", city, route, ratio: targetM / route.m };
    }
  }

  // In-range gap: nothing within ±MAX_BAND, so take the closest on a log scale.
  const off = (c: Candidate) => Math.abs(Math.log(c.route.m / targetM));
  const closest = pool.reduce((best, c) => (off(c) < off(best) ? c : best));
  return { kind: "match", city: closest.city, route: closest.route, ratio: targetM / closest.route.m };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter app exec vitest run src/cityMatch.test.ts && pnpm --filter app exec tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm typecheck && pnpm test && pnpm --filter app test`
Expected: everything green. (Python tests are unaffected; `pnpm run test:all` is optional.)

- [ ] **Step 6: Confirm nothing loads the dataset at startup**

Run: `grep -rn "cities\"\|cityMatch\"\|loadCities" app/src --include=*.tsx`
Expected: no matches — the data layer is unused until the UI work.

- [ ] **Step 7: Commit**

```bash
git add app/src/cityMatch.ts app/src/cityMatch.test.ts
git commit -m "feat: pickCity weighted band match with over/under"
```
