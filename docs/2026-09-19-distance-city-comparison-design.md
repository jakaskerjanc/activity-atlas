# Design: Distance → comparison-city ("you rode X km — that's Ljubljana → Y")

Date: 2026-09-19 (revised 2026-09-23; UI added 2026-11-05)
Status: decisions settled

## Problem

Give a ride/foot total a human anchor: "you rode 2,500 km — as a single ride
that's Ljubljana → Lisbon." Given the activities we already have, pick a
recognizable city that is about that far from Ljubljana **by bike or on foot**,
and ship the route so a map layer can draw it later.

For scale (real data, 2026-09-23): 418 activities, ~5,800 km all-time.
- Ride: 2,574 km
- On foot: 3,201 km (Hike 1,467, Run 1,189, Walk 545)
- Workout/Swim: 21 km

The total grows ~2,000 km/year. A month is typically 100–300 km. So group
totals span ~20 km (one activity) to ~6,000+ km (all-time, a few years out).

Constraints that shape the design:

- **The start city is always Ljubljana.** This is what makes precompute cheap:
  the expensive axis (routing) collapses to one origin.
- **No routing API has a "find a city N km away" primitive.** Routers only
  measure distance between points you already supply. So we bring our own
  candidate cities and measure once, offline of the app.
- **Serverless SPA (Vite static build).** Runtime has no backend; anything the
  app needs is a committed static asset it fetches.

## Scope

The build script, the committed dataset, pure tested app-side helpers
(`loadCities`, `activityGroup`, `groupTotals`, `seededRng`, `pickCity`,
`cityComparisons`), and the UI: a card on the Analytics page, and the city's
route drawn on the map (see [UI](#ui)).

## Router: OSRM (FOSSGIS public server), not Mapbox

Mapbox stays the map; it is **not** used for routing. Its `cycling`/`walking`
profiles don't reach the distances we need. Measured from Ljubljana
(2026-09-23):

| Destination | Mapbox cycling | OSRM bike | OSRM foot |
|---|---|---|---|
| Zagreb | 155 km | 153 km | 143 km |
| Munich | `NoRoute` | – | – |
| Prague | `NoRoute` | 560 km | 568 km |
| Paris | `NoRoute` | 1,329 km | 1,219 km |
| Lisbon | `InvalidInput: Route exceeds maximum distance limitation` | 2,818 km | 2,655 km |
| Moscow | same | 2,410 km | 2,439 km |
| Beijing | – | 10,854 km | 10,135 km |

The FOSSGIS OSRM server (`https://routing.openstreetmap.de/routed-{bike,foot}/`)
routes worldwide on OSM data, with real bike/foot profiles, **no API key**,
and 0.1–0.7 s per call at any distance. Other options were rejected:

- **OpenRouteService:** 6,000 km cap on every profile, and needs a key.
- **GraphHopper free tier:** 500 credits/day and non-commercial only.
- **Google:** its terms forbid storing results and drawing them on a
  non-Google map.

Its usage policy: **max 1 request/second, no heavy usage, a valid
User-Agent**. The one-time build of ~1,040 requests at 1 req/s (~18 min) fits
that; the app itself never calls it (routes are precomputed, below).

**Ferries.** OSRM's public server rejects `exclude=ferry` ("Exclude flag
combination is not supported"). Ferries are therefore detected from
`steps=true`, where ferry legs are steps with `mode: "ferry"`. Dropping *any*
route with a ferry would be wrong: foot routes use short river ferries even to
Prague (0.08 km) and Paris (8 km). Instead, **a profile's route is rejected
when its total ferry distance exceeds 20 km**. That rejects Reykjavík (bike:
439 km of ferry; foot: 1,090 km) while keeping river crossings.

## Approach

Everything network-bound happens once at build time. The app ships one static
file containing distances **and** simplified route lines:

```
GeoNames subset (build input, committed, pre-filtered)
        │  scripts/build-city-distances.ts
        │    stage A (pure, no network): distance-scaled population floor,
        │      log-spaced great-circle buckets from Ljubljana,
        │      capitals first, then population; K=10 ≤ 6,000 km, K=3 beyond
        │      → ~520 candidates
        │    stage B (network, 1 req/s): OSRM bike + foot per candidate,
        │      ferry check, simplify route to 500 m, encode polyline
        │    stage C (pure): validate coverage + sanity, print report
        ▼
app/public/city-distances.json   (COMMITTED — network-derived; measured 778 KB raw / 290 KB gz)
        │  fetched the first time the Analytics page (or a city route) needs it
        ▼
app/src/cities.ts     loadCities() → { origin, cities: CityDistance[] }, decoded once
app/src/cityMatch.ts  activityGroup / groupTotals / seededRng / pickCity / cityComparisons
        │  visible activities → cityComparisons → Analytics card; "Show on map" → route.coords
```

Alternatives rejected:

- **Haversine only (no routing):** cheaper still, but the user wants true road
  distance, and OSRM makes it free.
- **Live route fetch at runtime:** it would depend on a volunteer server's
  uptime and usage policy from every visitor's browser, and it adds 0.1–6 s of
  latency. Precomputing makes the line instant and guaranteed to match the
  stored distance.
- **One route file per city:** a smaller per-view download (~1–35 KB), but
  ~1,000 files. At 500 m simplification with thinned far buckets, a single
  file is ~1 MB gzipped, which is acceptable when lazy-loaded.

## Data source: candidate cities

Build-time input only (never shipped to the app): a subset of the GeoNames
[`cities15000`](https://download.geonames.org/export/dump/) dump, vendored at
`scripts/data/geonames-cities.json`:

```
{ id, name, country, lat, lon, population, fc }
// id = geonameid (stable key); fc = GeoNames feature code (PPLC capital, PPLA regional capital, PPL…)
```

**Only the pre-filtered subset is committed**, not the full dump: rows that
pass stage A's population floor, with just these seven fields. A small
`scripts/prepare-geonames.ts` (or a documented one-liner) converts a freshly
downloaded `cities15000.txt` into this file. Regeneration is a rare, manual step.
Committing the subset keeps the selection stage deterministic and offline.

## Stage A: selection (pure, unit-tested, no network)

`selectCandidates(cities, origin, opts) → Candidate[]`

1. Compute great-circle (Haversine) distance from Ljubljana to each city.
2. **Population floor scales with distance**: low near the origin so short
   totals have candidates (e.g. 15,000 within 300 km, which keeps Slovenian and
   nearby Croatian/Austrian/Italian towns), rising to 50,000+ farther out so
   distant picks stay recognizable.
3. **Log-spaced distance buckets**: 20 bins per decade from 20 km to
   12,000 km, each ~12 % wide.
4. **Rank within each bucket** so the best-known names are kept:
   - national capitals (`PPLC`) first;
   - then all others by population, with regional capitals (`PPLA`) counted
     at 1.5× population.
5. **Take the top K per bucket: K = 10 up to 6,000 km, K = 3 beyond.**
   This gives ~520 candidates.
   - The split sits at 6,000 km because that's where group totals land for
     years (see Problem). With 12 %-wide bins, K = 10 still leaves several
     cities inside a ±5 % band.
   - Far routes are most of the file size, because route bytes scale with
     length. Don't go below K ≈ 3 far out, or the same few cities repeat.
6. Return `{ id, name, country, lat, lon, population, fc }` for the selected set.

Great-circle is only a *coarse selection* filter. Final matching uses the
real route distance from stage B, so the straight-line/road mismatch here is
harmless (buckets are wide relative to it).

## Stage B: enrichment (network, one-time / occasional)

For each candidate and each profile (`bike`, `foot`):

```
GET https://routing.openstreetmap.de/routed-{bike|foot}/route/v1/driving/{lon,lat};{lon,lat}
    ?overview=full&geometries=geojson&steps=true
```

(The `driving` path segment is fixed OSRM URL syntax; the server behind
`routed-bike`/`routed-foot` decides the profile.)

- **Accept:** `code === "Ok"` and total ferry distance (sum of steps with
  `mode === "ferry"`) ≤ 20 km. Then:
  - store `m` = `routes[0].distance` (meters);
  - simplify the geometry with the existing `scripts/simplify.ts`
    (`simplifyLngLat`) at **500 m** tolerance;
  - encode it as a Google polyline (precision 5, `[lat,lng]`), the same format
    and library `build-tracks.ts` uses.
- **Reject that profile** (set it to `null`, log the reason) if there's too much
  ferry, `NoRoute`, or any other non-`Ok` code.
- **Reject on snapping:** outside its map coverage OSRM doesn't fail, it snaps
  the endpoint to the nearest covered road (measured: Bogotá → Portuguese coast,
  7,666 km away; Annaba → Sardinia, 235 km). Reject when any `waypoints[].distance`
  exceeds 5 km.
- **Drop the city** only if **both** profiles are `null`.
- **Politeness / throughput:** strictly sequential, **≥ 1 s between request
  starts** (the server's policy), User-Agent `strava-on-maps-build (<repo URL>)`.
  Per-request timeout (e.g. 30 s via `AbortController`). Retry with backoff on
  429/5xx/timeout, max 3 attempts, then record as a failure (not cached, so a
  re-run retries it). ~520 × 2 ≈ 1,040 requests ≈ 18 min. No key and no cost.
- **Resumable:** append each result (accepted *or* rejected, keyed by
  `id` + profile) to a gitignored cache, `scripts/data/.city-distances-cache.jsonl`.
  - A re-run skips entries already measured, so an interrupted run resumes
    instead of restarting.
  - Tuning stage A only measures the *new* candidates.
  - `--fresh` ignores the cache.

## Stage C: validation (pure, unit-tested)

Before writing the output, check the resolved dataset per profile.

- **Fail the build** (non-zero exit, no output written) on a **coverage hole**:
  any target distance between 20 km and 6,000 km with no city whose route
  distance is within ±40 % of it. A hole is exactly what would make `pickCity`
  fall back to a far-off match. Check it on a log grid of targets, e.g. 50 per
  decade.
- **Warn** (listed in the report, build continues) on **suspicious routes**:
  - route distance < great-circle distance (impossible, so a bad geocode);
  - route distance > 3× great-circle distance (strange detour).
- **Report:**
  - candidates, kept, per-profile rejected (by reason), failed;
  - the smallest and largest `m` per profile;
  - output size raw and gzipped, so K and the tolerance can be tuned against
    real numbers.

**Size budget (measured on 10 real OSRM bike routes, extrapolated).** At 500 m
simplification an encoded route costs ~1–1.5 bytes/km:

| Route | Simplified size |
|---|---|
| Zagreb | 0.2 KB |
| Paris | 2.0 KB |
| Lisbon | 1.6 KB |
| Beijing | 12.5 KB |

Across ~520 cities × 2 profiles, the file is **~1.7 MB raw / ~1.0 MB gzipped**
(±50 %; for scale, `tracks.json` is 274 KB / 162 KB gz). 500 m is overview
quality: invisible at country/continent zoom, but the line visibly cuts corners
at street zoom.

## Output: `app/public/city-distances.json`

```jsonc
{
  "v": 1,
  "generated": "2026-09-19",
  "router": "osrm-fossgis",
  "simplifyM": 500,
  "origin": { "name": "Ljubljana", "lat": 46.0569, "lon": 14.5058 },
  "cities": [
    { "id": 3186886, "name": "Zagreb", "country": "HR", "fc": "PPLC",
      "lat": 45.81, "lon": 15.98, "population": 698966,
      "cycling": { "m": 153000, "poly": "…" },
      "walking": { "m": 143000, "poly": "…" } }   // either may be null
    // …sorted by cycling.m asc (cities with cycling: null at the end)
  ]
}
```

Committed to git (unlike the display files in `app/public/data/`, which every
build regenerates from the database). Each regeneration adds ~2 MB to history, which is
fine at the expected rare cadence. The `.jsonl` cache *is* gitignored.

## Runtime: loading (`app/src/cities.ts`)

```ts
function loadCities(): Promise<CityData>; // { origin: CityOrigin; cities: CityDistance[] }
```

Fetches `city-distances.json`, checks `v` (throws on an unknown version), and
decodes each polyline once into `[lng, lat][]` (`@mapbox/polyline` gives
`[lat,lng]`, so flip). The promise is kept for the session, like the route
profiles (`routeProfiles.ts`); a failed load is forgotten so the next call
retries. `useCities(enabled)` wraps it as a load state. Result shape per city:

```ts
interface CityOrigin { name: string; lat: number; lon: number }
interface CityRoute { m: number; coords: [number, number][] }
interface CityDistance {
  id: number; name: string; country: string; fc: string;
  lat: number; lon: number; population: number;
  cycling: CityRoute | null;
  walking: CityRoute | null;
}
```

## Runtime: grouping and matching (`app/src/cityMatch.ts`, pure)

```ts
type Profile = "cycling" | "walking";

function activityGroup(type: string): Profile | null;
function groupTotals(activities: readonly ActivityRecord[]): Record<Profile, number>; // meters
function seededRng(profile: Profile, totalM: number): () => number;

interface CityPick {
  kind: "match" | "over" | "under"; // over: beyond the farthest city; under: short of the nearest
  city: CityDistance;               // the match, or the farthest / nearest city
  route: CityRoute;
  ratio: number;                    // targetM / route.m
}

function pickCity(
  cities: CityDistance[],
  targetM: number,
  profile: Profile,
  rng: () => number = Math.random,
): CityPick;

interface CityComparison { profile: Profile; totalM: number; pick: CityPick }
function cityComparisons(activities: readonly ActivityRecord[], cities: CityDistance[]): CityComparison[];
```

**`activityGroup`**: which comparison an activity feeds.
- `Virtual*` types → `null` (indoor, not a distance on the ground).
- Type containing "ride" → `cycling`. That includes `EBikeRide`,
  `GravelRide` and `MountainBikeRide`.
- `isFootBased(type)` (run/walk/hike, from `format.ts`) → `walking`.
  That includes `TrailRun`.
- Anything else (`Workout`, `Swim`, …) → `null`.

**`groupTotals`**: sums `distance` per group, skipping `null` groups and
activities without a distance. It works on whatever records the caller passes;
the UI passes the visible activities, with or without a route, the same set
the Totals card counts.

**`seededRng`**: a small deterministic PRNG (e.g. mulberry32), seeded from a
hash of `profile` and `totalM` rounded to the km. The same filter always gives
the same city; a different total can give a different one.

**`pickCity`**:
- Only cities with a non-null route for `profile` are considered.
- **Over:** `targetM > farthest.m × (1 + maxBand)` → `{ kind: "over" }`.
- **Under:** `targetM < nearest.m × (1 − maxBand)` → `{ kind: "under" }`.
- **Match:** collect cities within ±band of `targetM` (default ±5 %). If none,
  **widen** ×2 per step up to `maxBand` (±40 %).
- **Weighting:** among the candidates, pick with the injected `rng`, weighted
  by **population × 2 for capitals (`PPLC`) × 1.5 for regional capitals
  (`PPLA`)**.
- **In-range gap** (no city within ±40 % even though the target is between
  nearest and farthest): return the **closest city by |log(m / targetM)|** as
  a `match`, with its true `ratio`. Stage C's coverage check makes this rare
  below 6,000 km.
- Every case carries `city`, `route` and `ratio`; `kind` tells the caller which
  case it is, and there is no `null` to interpret. `route.coords` is what a map
  layer draws, with no network call.

**`cityComparisons`**: one `CityComparison` per group with a total > 0 (cycling
first), each picked with `seededRng(profile, totalM)`, so the same activities
always land on the same city. A group no city has a route for is left out.

## UI

**Analytics: "How far is that?"**, the card under Totals. One row per
comparison:

```
RIDES · 2,704 KM
Ljubljana → Krasnodar                                  [Show on map →]
2,648 km by bike · Russia · 102% of the way
```

- The share is `ratio` as a percentage, or "2.3×" from twice the route on.
  `under` leads the route with "Not yet", `over` with "Beyond".
- The country is the ISO code through `Intl.DisplayNames`.
- While the cities load, or if they fail, the card says so in a status line.

**"Show on map"** switches to the map and draws that group's route:

- A dashed line in the theme's strongest ink (white on dark, near-black on
  light) over a casing, above the activities, so it reads apart from them in
  every color mode. Its ends are DOM markers labelled with the origin and city
  names (no glyphs needed from the base style).
- The camera flies to the whole route, in the strip clear of the side panel.
  Mapbox's `cameraForBounds` only uses the padding for the zoom, so the fly-to
  is offset by the padding's asymmetry (`fitOffset`), with room for the labels.
- The bottom panel shows the trip: title "Ljubljana → City", subtitle
  "By bike · Country", cards Route km, Rides/On foot km, Of the way, and
  Straight km (great circle), and a "Hide route" button.

**State.** App holds only *which group's* route is shown. The comparison
itself is derived from the visible activities, so the route follows the
activity filter: a filter that changes the total can move it to another city
(the camera refits), and one that leaves the group no distance takes it down.
The route and a selected activity share the bottom panel, so selecting an
activity, clicking empty map, or starting replay hides the route. It isn't in
the URL; back from the map returns to Analytics.

## Testing

- **Script (`tsx --test scripts/*.test.ts`):**
  - Stage A:
    - Haversine correctness and the distance-scaled population floor
    - log bucketing: short *and* far buckets populated
    - K = 10 / K = 3 caps around the 6,000 km split
    - capitals win their bucket; regional capitals get the 1.5× rank boost
    - deterministic ordering
  - Stage B, through a `fetchRoute(profile, dest)` seam with stubbed OSRM
    responses:
    - `Ok` without ferries → accepted, simplified, polyline round-trips
      within tolerance
    - river ferry ≤ 20 km → accepted
    - ferry > 20 km → that profile `null`
    - both profiles `null` → city dropped
    - `NoRoute` → `null`
    - 429 then `Ok` → retried
    - timeout → retried, then recorded as a failure
    - cache hit → no call
    - the throttle spaces calls ≥ 1 s apart (injected clock/sleep)
  - Stage C:
    - a coverage hole fails
    - full coverage passes
    - the route < great-circle and > 3× great-circle warnings fire
  - No live network in CI.
- **App (vitest):**
  - `cities.ts`: parse + decode with a fixture (`[lat,lng]` → `[lng,lat]`
    flip, origin kept, `null` profiles preserved, unknown `v` rejected); the
    load is kept, and a failed one retried.
  - `activityGroup`: `Ride`, `EBikeRide` and `GravelRide` → cycling; `Run`,
    `TrailRun`, `Walk` and `Hike` → walking; `VirtualRide`, `VirtualRun`,
    `Workout` and `Swim` → `null`.
  - `groupTotals`: mixed activities are summed per group; excluded types and
    unknown distances are ignored.
  - `seededRng`: the same input gives the same sequence; a different
    total/profile gives a different sequence.
  - `pickCity`:
    - in-band pick, progressive widening
    - in-range gap → closest by log ratio
    - `over`, `under`
    - capital/regional weighting (injected `rng`)
    - profile isolation (cities with a `null` route for the profile are ignored)
  - `cityComparisons`: one per group with distance, cycling first; reproducible.
  - `cityView.ts`: km and share formatting, country names, the row detail, and
    the map panel's cards.
  - `AnalyticsView`: the card's loading, error, empty and ready states, and the
    "Show on map" button.
  - `layout.ts`: `fitPadding`'s margin and `fitOffset`.

## File plan

Add:
- `scripts/build-city-distances.ts`: stages A + B + C + `main()` (mirrors
  `build-tracks.ts`: pure core exported, `main()` guarded for direct run).
- `scripts/build-city-distances.test.ts`: stage A/C + `fetchRoute` seam tests.
- `scripts/prepare-geonames.ts`: `cities15000.txt` → filtered
  `geonames-cities.json` (or a documented one-liner instead).
- `scripts/data/geonames-cities.json`: vendored, pre-filtered build input.
- `app/public/city-distances.json`: generated, **committed** output.
- `app/src/cities.ts` + `app/src/cities.test.ts`.
- `app/src/cityMatch.ts` + `app/src/cityMatch.test.ts`.
- `app/src/cityView.ts` + `app/src/cityView.test.ts`: display text.
- `app/src/ui/useCities.ts`: the load state.
- `app/src/ui/CityComparisons.tsx`: the Analytics card's rows.

Edit:
- `app/src/App.tsx`: which group's route is shown, and the bottom panel for it.
- `app/src/ui/AnalyticsView.tsx`: the "How far is that?" card.
- `app/src/MapView.tsx` + `app/src/index.css`: the route layers, end markers,
  and the fit.
- `app/src/ui/layout.ts`: `fitPadding` margin, `fitOffset`.
- `scripts/types.ts` (or a new `scripts/city-types.ts`): the wire types
  (`CityDistancePayload`, encoded per-profile route). Mirror the app-side copy
  per the existing keep-in-sync convention (`app/src/types.ts`).
- `package.json`: `build:cities` script (`tsx scripts/build-city-distances.ts`),
  **not** wired into `build` (it needs network and ~18 min; run manually).
- `.gitignore`: `scripts/data/.city-distances-cache.jsonl`.
- `README.md`: how to regenerate, and the OSRM usage policy the script obeys
  (1 req/s, User-Agent, one-time use).

No Mapbox token changes: routing never touches Mapbox, and the app makes no
routing calls at runtime.

## Non-goals

- A "🎲 another city" re-roll button.
- A comparison for a single selected activity.
- **Multiple origins**: design assumes Ljubljana only. A second origin would
  re-run stage B per origin and key the asset by origin.
- **If the public OSRM server ever becomes unusable** for the (rare)
  regeneration, the same script can target a self-hosted OSRM (the base URL is
  a constant). The shipped app is unaffected either way.
- Exact tuning constants (floor curve, bins per decade, K and the 6,000 km
  split, 20 km ferry threshold, 500 m tolerance, band %, capital weights) are
  settable during implementation against the stage C report; defaults above.
