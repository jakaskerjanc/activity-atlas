// Build app/public/city-distances.json: recognizable cities at real bike/foot
// route distances from Ljubljana, with simplified route lines, so the app can
// say "you rode X km — that's Ljubljana → Y". Network-bound and slow (~18 min),
// so it runs manually (`pnpm run build:cities`) and its output is committed.
// See docs/2026-09-19-distance-city-comparison-design.md.
//
//   stage A (pure)    select ~520 candidates from the vendored GeoNames subset
//   stage B (network) measure each with OSRM bike + foot, 1 req/s, cached
//   stage C (pure)    validate coverage + sanity, report, write

import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { Candidate, EncodedCity, EncodedCityRoute, GeoCity, LatLon, Profile } from "./city-types.ts";

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
