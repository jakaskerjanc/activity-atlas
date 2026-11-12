# Places and Same-Route Groups, Plan 2: Site

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The site lets the owner pick a place in the filter panel ("Hikes to Slavnik"). For a selected activity, it shows its place and the other times on the same route.

**Architecture:**
- `build-tracks.ts` reads the group tables that Plan 1 fills and writes `places.json`, plus `place` and `route` ids on each activity record.
- In the app, the place becomes a third part of the activity filter in `activityFilter.ts`. Every page already reads that filter, so the map, stats, Analytics and replay follow it with no extra wiring.
- Pure modules hold the list, title and route-table rules, each tested directly. Thin React components render them, and `MapView` gains a group highlight and a fly-to on pick.

**Tech Stack:** TypeScript, React 19, Vite, mapbox-gl 3, vitest for the app, `tsx --test` for `scripts/`, better-sqlite3 in the build.

**Spec:** `docs/2026-11-08-place-tags-design.md`, sections "The site's data" and "UI". This plan builds on Plan 1 (`docs/2026-11-09-places-and-routes-plan-1.md`): the `places`, `route_groups` and `activity_groups` tables.

## Global Constraints

- **`places.json` version 1:** `{v: 1, places: [{id, name, ele, kind}], routes: [{id, name}]}`. No coordinates of any kind.
  - `places` holds places with ≥ 1 visible activity. `kind` is `peak|pass|top`.
  - `routes` holds route groups with ≥ 2 visible activities.
- **Activity records:** `place?` and `route?` are optional keys, left out when unknown. `ACTIVITIES_VERSION` stays 1. The wire types (`PlacesFile`, `Place`, `RouteName`, `ActivityRecord`) must stay in sync between `scripts/types.ts` and `app/src/types.ts`; the app copy also holds frontend-only types.
- **Places list:**
  - It sits between Activity types and Date range, in the type list's row style.
  - Order: count descending, then name. The first 8 rows show, then `+ N more` (`aria-expanded`) opens the rest, and `Show fewer` closes it.
  - Search ignores case and accents and shows every match.
  - A place with a count of 0 is left out, except the selected one.
  - One place at a time; clicking the selected place clears it. Rows are buttons with `aria-pressed`, and the search box has a label.
  - The section is hidden only when `places` is empty. The demo data has places, so a fork shows it.
- **Facet counts** (Claude's call, open to the owner): type counts follow the date range and the place but ignore the type selection. Place counts follow the type selection and the date range but ignore the place. With Slavnik picked, the type list counts activities to Slavnik.
- **Empty map:** with a place selected and nothing visible, the notice names the place and offers clearing it, next to Reset filters.
- **Titles:** `"{Types} to {name}"` for one type and a peak or top, `"{Types} over {name}"` for one type and a pass, `"To {name}"` / `"Over {name}"` for several types, and `"All activities"` without a place. `{Types}` is the plural label of the type: Hikes, Runs, Rides, Walks; any other type reads `"{type} activities"`.
- **Camera:** picking a place (from the list or the place row) flies to the densest cluster of the remaining visible routes, with a closest zoom of 12 and replay's easing, over 900 ms. Clearing doesn't move the camera.
- **Selected activity rows,** under the stat cards and above the charts:
  - Place row: `"To {name} · {n} times →"`, or `"Over {name} · …"` for a pass. `n` counts every activity with that place, whatever the filter. Clicking it sets the place.
  - Route row: `"{route name} · {n}× ▸"` (`aria-expanded`). It expands a table newest first: date, moving time, plus pace for runs. The current activity is marked, and the fastest moving time is labelled `fastest` when ≥ 2 rows have one.
  - While the table is open, the group's routes are highlighted and the others dimmed.
  - Rows outside the filter are greyed out. Clicking one widens the date range to include its month, switches its type on, and clears the place if it differs.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Picking a place whose activities all lie outside the date range** → the place stays selected with 0, the map is empty, the title still reads "Hikes to Slavnik", and the empty notice names Slavnik and offers clearing it. Nothing crashes, and the camera doesn't fly when there's nothing to fit. Tests in Tasks 2 and 3, and the camera check in Task 4.
2. **Replay started while a place is selected** → it replays only that place's activities. Test in Task 2 (`visibleFeatures` respects the place).
3. **Search with and without accents, in either direction** ("smarna", "ŠMARNA", "šmarna" all find Šmarna gora, and "Vršič" finds Vršič) → found. Test in Task 3.
4. **A route-mate hidden by the type filter and in another place** → its row is greyed. Clicking it switches its type on, widens the dates and clears the place, and the activity ends up visible and selected. Test in Task 5.
5. **A database without the group tables** (a fork's old database or a stale demo) → the build writes an empty `places.json` and records without `place`/`route`, and the site works as today. Test in Task 1.

---

## File Structure

```
scripts/types.ts, app/src/types.ts   # PlacesFile, Place, RouteName; ActivityRecord.place?/route?
scripts/build-tracks.ts              # readPlaces(db), places.json, record ids
scripts/testDb.ts                    # group tables in the throwaway db
app/src/activityFilter.ts            # place part: togglePlace, placeCounts, typeCounts follows the place, revealActivity
app/src/places.ts                    # PLACES_URL, checkPlacesFile, normalizeName, listedPlaces, placeTitle, emptyNotice
app/src/routeGroup.ts                # placeLine, routeTable
app/src/ui/PlacesSection.tsx         # the filter panel section
app/src/ui/GroupRows.tsx             # the two rows on the selected activity
app/src/ui/FilterSection.tsx, SidePanel.tsx, App.tsx, MapView.tsx
CONTEXT.md
```

---

### Task 1: `places.json` and ids on activity records

**Files:**
- Modify: `scripts/types.ts`, `app/src/types.ts`, `scripts/build-tracks.ts`, `scripts/testDb.ts`
- Test: `scripts/build-tracks.test.ts`

**Interfaces:**
- Produces in both `types.ts` files:

```ts
export interface Place { id: string; name: string; ele: number; kind: "peak" | "pass" | "top" }
export interface RouteName { id: string; name: string }
/** Root of places.json: places reached and named same-route groups. No coordinates. */
export interface PlacesFile { v: 1; places: Place[]; routes: RouteName[] }
// ActivityRecord gains:
  /** place id (an activity id), when the activity climbed to a place */
  place?: string;
  /** same-route group id (an activity id), when the group has ≥ 2 visible activities */
  route?: string;
```

- Produces in `build-tracks.ts`:
  - `PLACES_VERSION = 1`, and `DisplayFiles.places: PlacesFile`.
  - `readPlaces(db): { file: PlacesFile; placeOf: Map<string, string>; routeOf: Map<string, string> }`
    - Uses only visible activities.
    - `routes` keeps groups with ≥ 2 visible members, and `routeOf` only maps those.
    - Missing tables give an empty file and empty maps.
  - `toRecord` sets `place` and `route` from those maps.
  - `writeDisplayFiles` writes `places.json`, and the header comment lists it.
- `testDb.ts` creates `places`, `route_groups` and `activity_groups` with Plan 1's columns, plus a `withoutGroupTables` option.

- [ ] **Step 1: Write the failing tests**

```ts
test("places.json lists places with visible activities and routes with two or more", () => { ... });
test("activity records carry place and route ids, left out when unknown", () => { ... });
test("a hidden activity does not count toward a route's two members", () => { ... });
test("places.json carries no coordinates", () => { /* JSON.stringify(file) has no "lat"/"lon"/"lng" keys */ });
test("a database without group tables builds an empty places.json", () => { ... });
```

- [ ] **Step 2: Run** `pnpm run test`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run** `pnpm run test && pnpm run typecheck`. Expected: PASS. The committed demo database (regenerated in Plan 1) still builds, and its `places.json` lists places.
- [ ] **Step 5: Commit** `feat: places.json and place/route ids in activities.json`

---

### Task 2: The place in the activity filter

**Files:**
- Modify: `app/src/activityFilter.ts`
- Test: `app/src/activityFilter.test.ts`

**Interfaces:**
- Produces:
  - `ActivityFilter.place: string | null` (null from `createActivityFilter`).
  - `togglePlace(filter, id: string): ActivityFilter`: picking the selected place again clears it. Types and dates are untouched.
  - `passes` and `filterExpression` also require `a.place === filter.place` when a place is set. The expression adds `["==", ["get", "place"], filter.place]`.
  - `placeCounts(filter): Record<string, number>`: activities per place that pass the type selection and date range, ignoring the place.
  - `typeCounts(filter)`: activities per type inside the date range and, when a place is set, with that place. It still ignores the type selection. Its doc comment says so.
  - `revealActivity(filter, a: ActivityRecord): ActivityFilter`:
    - turns `a.type` on
    - widens `fromMonth`/`toMonth` just enough to include `monthIndex(a.ts)`
    - sets `place` to null if `a.place !== filter.place`
    - returns the same object when `a` already passes

- [ ] **Step 1: Write the failing tests**

```ts
test("togglePlace sets, then clears on the same id, and keeps types and dates", ...);
test("visibleActivities and visibleFeatures keep only the place's activities", ...);   // replay reads visibleFeatures
test("filterExpression matches visibleFeatures with a place set", ...);                 // same check style as the existing expression test, via featureFilter
test("placeCounts follow types and dates but ignore the place", ...);
test("typeCounts follow the place and dates but ignore the types", ...);           // Slavnik picked, Hike off → Hike still counts its hikes to Slavnik, Run counts 0
test("a selected place outside the date range leaves nothing visible", ...);
test("toggleMonth (the ridgeline click) keeps the place", ...);
test("revealActivity widens dates, turns the type on, clears a different place", ...);
test("revealActivity returns the same filter when the activity already passes", ...);
```

- [ ] **Step 2: Run** `pnpm --filter app run test -- activityFilter`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above, keeping one `passes` rule for all three readers, as the module's header asks.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: place selection in the activity filter`

---

### Task 3: List and title rules

**Files:**
- Create: `app/src/places.ts`
- Test: `app/src/places.test.ts`

**Interfaces:**
- Consumes: `PlacesFile`, `ActivityFilter`, `placeCounts`.
- Produces:
  - `PLACES_URL = `${import.meta.env.BASE_URL}data/places.json``
  - `checkPlacesFile(raw: unknown): PlacesFile`: an unknown `v` or a bad shape returns `{v: 1, places: [], routes: []}` and logs one `console.warn`. The site degrades to "no places" and never fails to load.
  - `normalizeName(s: string): string`: NFD, combining marks removed, lowercased.
  - `PLACES_SHOWN = 8`
  - `interface PlaceRow { place: Place; count: number; selected: boolean }`
  - `listedPlaces(places: readonly Place[], counts: Record<string, number>, selected: string | null, query: string, expanded: boolean): { rows: PlaceRow[]; more: number }`
    - Drops count 0 unless selected, then sorts by count descending and then by name (`localeCompare(b, "sl")`).
    - A non-empty `query` filters by `normalizeName` substring and shows every match.
    - Otherwise it shows the first 8 (all when expanded). The selected place is appended when it falls past them.
    - `more` = how many are hidden.
  - `placeTitle(filter: ActivityFilter, places: ReadonlyMap<string, Place>): string`, per Global Constraints. A place id missing from the map reads "All activities".
  - `emptyNotice(filter: ActivityFilter, places: ReadonlyMap<string, Place>): { text: string; clearPlace: boolean }`, the notice shown when nothing is visible.
    - Without a place (or with one missing from the map): today's text, "No activities match these filters. Switch on an activity type or widen the date range.", and `clearPlace: false`.
    - With a place: "No activities to {name} match these filters. Switch on an activity type, widen the date range, or clear the place.", "over" for a pass, and `clearPlace: true`.

- [ ] **Step 1: Write the failing tests**

```ts
test("search ignores case and accents both ways", () => { for (const q of ["smarna", "ŠMARNA", "šmarna"]) expect(names(listedPlaces(ps, c, null, q, false))).toEqual(["Šmarna gora"]); });
test("first 8 by count then name, more counts the rest", ...);
test("zero-count places drop out, the selected one stays with 0", ...);
test("a selected place past the first 8 is still shown", ...);
test("titles", () => { /* Hike+Slavnik → "Hikes to Slavnik"; Ride+Vršič(pass) → "Rides over Vršič"; Hike+Ride+Slavnik → "To Slavnik"; WeightTraining+top → "WeightTraining activities to …"; no place → "All activities" */ });
test("an unknown places.json version degrades to no places", ...);
test("the empty notice names the selected place and offers clearing it", ...);   // Slavnik → "No activities to Slavnik …", clearPlace true; Vršič → "over"; no place → today's text, clearPlace false
```

- [ ] **Step 2: Run** `pnpm --filter app run test -- places`. Expected: FAIL.
- [ ] **Step 3: Implement `places.ts`.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: places list and title rules`

---

### Task 4: Places section in the filter panel, loading, title and camera

**Files:**
- Create: `app/src/ui/PlacesSection.tsx`
- Modify: `app/src/ui/FilterSection.tsx` (render it between the types and the `<hr>` before Date range), `app/src/ui/SidePanel.tsx` (pass `places`), `app/src/App.tsx`, `app/src/MapView.tsx`
- Test: `app/src/ui/PlacesSection.test.ts`, `app/src/ui/SidePanel.test.ts`

**Interfaces:**
- Consumes: `listedPlaces`, `placeCounts`, `togglePlace`, `placeTitle`, `emptyNotice`, `checkPlacesFile`, `PLACES_URL`.
- Produces:
  - `PlacesSection({ filter, places, onChange }: { filter: ActivityFilter; places: readonly Place[]; onChange: (f: ActivityFilter) => void })`
    - It returns null when `places` is empty.
    - It keeps its own `query` and `expanded` state.
    - It renders the heading "Places", the labelled search box, rows (kind icon ▲ for a peak, a saddle icon added to `icons.tsx` for a pass, none for a top; name; `ele` formatted `1,028 m`; count in the type list's count style), and `+ N more` / `Show fewer`.
  - `FilterSection` and `SidePanel` props gain `places: readonly Place[]`.
  - `App` fetches `places.json` in the existing `Promise.all`, through `checkPlacesFile`. A failed fetch counts as no places, and only `routes.json` or `activities.json` failing remains fatal.
    - It keeps `places`, a `placeMap` (id → `Place`) and a `routeMap` (id → name).
    - The "All activities" title becomes `placeTitle(filter, placeMap)`.
    - The empty-map notice takes its text from `emptyNotice(filter, placeMap)`. With `clearPlace`, a "Clear place" button (`togglePlace` on the selected id) sits before "Reset filters".
    - It holds `placeFlyEpoch`, incremented whenever a pick sets a place, but not when one is cleared.
  - `MapView` prop `placeFlyEpoch: number`. On a change, if `visible` is non-empty, it flies to `densestClusterBounds(visible)` via `cameraFor(bounds, 12)` with replay's `duration: 900` and cubic-out easing. An empty `visible` doesn't move the camera.

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`, as in `SidePanel.test.ts`)

```ts
test("no places renders nothing", ...);
test("rows are aria-pressed buttons with name, height and count", ...);
test("more button shows the hidden count and aria-expanded=false", ...);
test("SidePanel passes places through to the filter section", ...);
```

- [ ] **Step 2: Run** `pnpm --filter app run test -- PlacesSection SidePanel`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run** `pnpm --filter app run test && pnpm --filter app run build`. Expected: PASS.
- [ ] **Step 5: Check it in the app against real data.** A fresh worktree only has demo data, so set it up first:
  1. Copy `.env` from the main checkout (`chmod 600`).
  2. Run `PYTHON_BIN=<main checkout>/.venv/bin/python pnpm run sync`, then `pnpm install --frozen-lockfile && pnpm run build:tracks`.
  3. Plan 1 must have run on that database: the refresh happens on the next write job, or by running `ingest.refresh.refresh_file` on a copy.
  4. Start `pnpm --filter app run dev`.

  Then check:
  - Picking Slavnik with only Hike on shows "Hikes to Slavnik", and the map flies there.
  - The ridgeline click keeps the place.
  - A second click clears the place without moving the map.
  - With Slavnik picked and the date range moved past its hikes, the notice names Slavnik and "Clear place" brings the map back.
  - Searching "smarna" finds Šmarna gora.
  - On a phone-width window the list scrolls inside the overlay.
- [ ] **Step 6: Commit** `feat: Places section in the filter panel`

---

### Task 5: Place and route rows on the selected activity

**Files:**
- Create: `app/src/routeGroup.ts`, `app/src/ui/GroupRows.tsx`
- Modify: `app/src/App.tsx` (render `GroupRows` at the top of `panelBody`, above `ActivityCharts`)
- Test: `app/src/routeGroup.test.ts`, `app/src/ui/GroupRows.test.ts`

**Interfaces:**
- Consumes: `ActivityFilter`, `revealActivity`, `togglePlace`, `PlacesFile`.
- Produces:
  - `interface PlaceLine { id: string; name: string; kind: Place["kind"]; count: number }`
  - `placeLine(a: ActivityRecord, filter: ActivityFilter, places: ReadonlyMap<string, Place>): PlaceLine | null`: `count` covers `filter.activities` with the same place.
  - `interface RouteRow { id: string; ts: number; moving_time?: number; pace_s_per_km?: number; current: boolean; fastest: boolean; outside: boolean }`
  - `interface RouteTable { id: string; name: string; rows: RouteRow[] }`
  - `routeTable(a: ActivityRecord, filter: ActivityFilter, routes: ReadonlyMap<string, string>): RouteTable | null`
    - Members come from `filter.activities`, newest first.
    - `pace_s_per_km` is set only for `type === "Run"`, with both values known.
    - `fastest` marks the minimum `moving_time` when ≥ 2 rows have one.
    - `outside` is set for rows that fail the filter.
    - It returns null without a route, or with fewer than 2 members.
  - `GroupRows({ place, route, open, onToggle, onPickPlace, onSelect })`
    - The place row is a button: "To/Over {name} · {n} times" with →.
    - The route row is a button with `aria-expanded`: "{name} · {n}×" with ▸, or ▾ when open.
    - Its table is a list of buttons, with outside rows greyed and `fastest` and "this one" marks.
  - `App`:
    - `routeOpen` state, reset when the selected activity's route id changes.
    - `onPickPlace` uses `togglePlace` only when the place isn't already selected, then bumps `placeFlyEpoch`.
    - `onSelect(id)` on an outside row first applies `revealActivity`, then `selectActivity(id)`.

- [ ] **Step 1: Write the failing tests**

```ts
test("placeLine counts every activity with the place, whatever the filter", ...);
test("routeTable newest first with current, fastest and outside", ...);
test("pace only for runs", ...);
test("no table for a one-off or a missing route name", ...);
test("an outside mate in another place: reveal turns its type on, widens dates, clears the place", ...);
test("GroupRows renders the two rows and aria-expanded", ...);
test("a pass reads Over", ...);
```

- [ ] **Step 2: Run** `pnpm --filter app run test -- routeGroup GroupRows`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run** `pnpm --filter app run test && pnpm --filter app run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: place and same-route rows on the selected activity`

---

### Task 6: Highlight a route group on the map

**Files:**
- Modify: `app/src/MapView.tsx`, `app/src/App.tsx`
- Create: `app/src/activeTracks.ts`
- Test: `app/src/activeTracks.test.ts`

**Interfaces:**
- Produces:
  - `activeTrackIds(p: { replaying: boolean; hoverId: string | null; groupIds: readonly string[] | null; selectedId: string | null }): string[]`
    - Replay gives `[]`.
    - Otherwise hover wins as `[hoverId]`, then `groupIds` when non-empty, then `[selectedId]`, else `[]`.
  - `MapView`:
    - New prop `groupIds: readonly string[] | null`.
    - `currentActiveId()` becomes `currentActiveIds()` via `activeTrackIds`.
    - `syncFeatureState` diffs the set: `active: false` for ids that left, `true` for ids that joined.
    - The base-layer dimming reads "any active".
  - `App` passes `groupIds` = the ids of the open route table's rows that aren't `outside`, or null when it's closed.

- [ ] **Step 1: Write the failing tests**

```ts
test("replay suspends every highlight", ...);
test("hover beats the group, the group beats the selection", ...);
test("an empty group falls back to the selection", ...);
```

- [ ] **Step 2: Run** `pnpm --filter app run test -- activeTracks`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above. Keep it to feature-state writes, with no source relayout on toggle, matching the existing comment in `syncFeatureState`.
- [ ] **Step 4: Run** `pnpm --filter app run test && pnpm --filter app run build`. Expected: PASS.
- [ ] **Step 5: Check it in the app:**
  - Opening "Slavnik out-and-back via Skadanščina" highlights its routes and dims the rest.
  - Hovering another route still highlights only that one.
  - Closing the table restores the map.
  - Starting replay clears every highlight.
- [ ] **Step 6: Commit** `feat: highlight a same-route group on the map`

---

### Task 7: Words, docs and a final check

**Files:**
- Modify: `CONTEXT.md` (under Filtering and Interaction), `README.md` (one bullet under **Map:** or **Activity view:**)
- Test: none new

**Interfaces:** none.

- [ ] **Step 1: Update and add the terms in `CONTEXT.md`.** Two existing entries change:
  - **Activity filter**: "The user's current choice of which activities are shown: a type selection, a date range and an optional place selection."
  - **Type count**: "How many activities of a type fall inside the date range and the selected place, regardless of whether that type is switched on."

  The new terms each get an _Avoid_ line in the file's existing style:
  - **Place**: where activities went, found from their highest points and named automatically. _Avoid_: summit, destination, tag.
  - **Place selection**: the place part of the activity filter; one at a time. _Avoid_: place filter.
  - **Same route**: activities that followed the same track, in either direction. _Avoid_: matched activities, segment.
  - **Turnaround**: a flat route's farthest point from its start, which names it.
- [ ] **Step 2: Add one README bullet:** "pick a place to see every activity that went there, and the other times on the same route".
- [ ] **Step 3: Run** `pnpm run test:all && pnpm run typecheck && pnpm --filter app run build`. Expected: PASS.
- [ ] **Step 4: Measure the sizes** and record them in the design's "Done when", as it asks:
  - `places.json` (bytes raw and gzipped)
  - the raw OSM snapshots in the archive (`osm/<CC>/…`), per country, next to the design's 871 KB for Slovenia, which counts the parsed points only
  - the database size before and after `places:update` and the first refresh
  - the row counts of `osm_points`, `places`, `route_groups` and `activity_groups`
- [ ] **Step 5: Run Lighthouse** on the map page:
  1. Serve `app/dist` with a gzip-capable server (`npx serve@14 dist -l 4173`), not `vite preview`.
  2. Run `CHROME_PATH=/usr/bin/chromium npx lighthouse@13.6.0 <url> --chrome-flags="--headless=new --no-sandbox --enable-gpu --use-angle=gl"`. Without those flags, software WebGL inflates Total Blocking Time.
  3. Check `errors-in-console` has no "Failed to initialize WebGL".

  Expected: performance within ±3 of the last baseline (map 42 mobile / 71 desktop), and `places.json` under 20 KB.
- [ ] **Step 6: Commit** `docs: place, same route and turnaround in CONTEXT and README; sizes`
