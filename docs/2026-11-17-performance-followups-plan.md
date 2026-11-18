# Performance Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the five items the performance analysis left open: window the Activities list, rework how replay feeds Mapbox, stop loading data nobody is looking at, shrink the database transfer, and speed up the refresh after each write.

**Architecture:** Four independent parts, each its own PR. Part A windows the list with TanStack Virtual. Part B is a measured prototype of a small "replay window" source, then the production change. Part C makes `routes.json` non-blocking and fetches city route lines one city at a time. Part D bumps the database schema once (v6): the highest point is stored per activity, and the OSM points leave the database for a file named by the snapshots it was built from.

**Tech Stack:** React 19, Vite, vitest (server-rendered markup, no jsdom), mapbox-gl 3.30.0, `@tanstack/react-virtual` (new), Python 3.12+ with sqlite3 and boto3, pytest, Cloudflare R2.

**Spec:** the "What's left to do" list from the performance analysis (five items, quoted in each part's heading). There is no separate design doc.

## What the research found

Measured on the real database (541 activities, 452 with a route) on 2026-11-17.

| Item | Finding |
| --- | --- |
| 1 List | Rows are not one height: a phone row whose meta line wraps is 72 px, not 55 px, and an open preview is taller still. Windowing therefore needs measured heights. At 10× the earlier run counted 119,946 DOM nodes and one 5.3 s task on opening the page. |
| 2 Replay | In mapbox-gl 3.30.0, a feature-state change marks every bucket with state-dependent paint for upload. `Tile.upload` then copies the source's whole state map (`getState(layer, undefined)`) and re-sends each bucket's whole paint buffer. Both sources hold every route, so a finished route costs work proportional to all routes. At 10× there are about 100 finished routes a second, so this runs every frame. The earlier profile agrees: `getState` and `bufferSubData` lead Mapbox's self time. The second source (`activities-active`) is also filled on first load, replay or not. |
| 3 Files | Compressed today: `routes.json` 151 KB, `profiles.json` 61 KB, `activities.json` 47 KB, `city-distances.json` 301 KB. Without the lines the city file is 10 KB; one city's lines are 1.3 KB at the median, 19 KB at most. Only `App.tsx` reads the lines. At 541 activities a split by year would save nothing on first load. |
| 4 Database | 82.8 MB. `osm_points` and its two indexes are 37.6 MB (45.4%); without them the file is 45.0 MB. Only `ingest/refresh.py` reads the table, and `idx_osm_points_lat` is used by nothing. Not on the list: every changed write also uploads a full second copy as the daily snapshot, so one write moves 249 MB (pull, push, snapshot). |
| 5 Refresh | 5.8 s on this machine: reading every stream for the highest point 2.3 s, loading the OSM points 1.8 s, grouping 1.0 s, decoding polylines 0.6 s. |

## Global Constraints

- Never commit the database; `data/*` is gitignored.
- Run the rebuild as `PYTHON_BIN=<venv>/bin/python pnpm run rebuild`. Bare `pnpm rebuild` is pnpm's builtin and does nothing here.
- Before each commit: `pnpm run typecheck && pnpm run test:all`.
- Every display file carries a version its reader checks. Change a file's shape only with a version bump on both sides (`scripts/` and `app/src/`).
- An unknown value is left out of a display file, never written as `0`.
- Use the vocabulary in `CONTEXT.md` (activity, visible activities, activity preview, city route, place).
- Parts A to C change no behaviour a user can see, except what each task states.
- A schema bump makes the next writer rebuild the database from the archive. Parts D1 to D3 share one bump (v6) so that happens once.

## Review Focus

1. A focused row scrolled out of the window: arrow keys must still move from it (Task A2).
2. Phone rows that wrap, and an open preview: scrolling back up past them must not jump (Task A2).
3. Scrubbing backwards, changing the filter, or switching theme during replay: no route missing or drawn twice (Task B5).
4. `routes.json` failing, or arriving while an activity preview is open: Analytics and Activities keep working and the preview gains its track (Task C1).
5. A writer that cannot get the OSM points file: the refresh must fail with exit code 7, never rename every place to "Top at … m" (Task D3).

## Order

Part D first (largest saving per write, and independent of the app), then A, C, B. Part B's production task depends on its prototype's result. Task 0 comes before A and B.

---

### Task 0: Keep the 10× benchmark in the repo

The earlier analysis measured with two scripts that live in a temp folder a reboot clears: `/tmp/claude-1000/-home-jakas--t3-worktrees-activity-atlas-t3-61a9fe37/4733dbd4-4f05-4451-8fe3-a8c3c61d3a2c/scratchpad/prof/scale.mjs` and `interact.mjs` in the same folder. Copy them if they are still there; otherwise write them from the description below.

**Files:**
- Create: `scripts/perf/scale-display-files.mjs`
- Create: `scripts/perf/interact.mjs`
- Create: `scripts/perf/README.md` (the commands below, and the GPU flags)

**Interfaces:**
- Produces: `node scripts/perf/scale-display-files.mjs <srcDataDir> <outDataDir> [K=10]`. It writes `routes.json`, `activities.json` and `profiles.json` holding K copies of every activity: copy k has id `<id>_<k>`, `ts`, `start_date` and `start_local` moved back k years, its route shifted by `k * 0.003°` latitude and `k * 0.0021°` longitude, and `detail: false`. Copy 0 is the original.
- Produces: `BASE=<url> THROTTLE=<n> ONLY=<step,…> node scripts/perf/interact.mjs`. It prints one line per step: `wall`, `script`, `layout+style`, `frames`, `slow>34ms`, `p95`, `worst`, `long=[…]`, `nodes`. Steps Parts A and B need: `replay` (5 s of playback, at 1× and at 8×), `activities-open` (switch to Activities), `activities-sort`, `activities-clear-search`, `activities-preview`.
- Playwright comes from `PLAYWRIGHT_DIR` (default `/home/jakas/.local/share/mise/installs/playwright/latest/node_modules/`), Chromium from `/usr/bin/chromium` with `--headless=new --no-sandbox --enable-gpu --use-angle=gl`. Without the GPU flags Mapbox renders in software and the numbers mean nothing.

- [ ] **Step 1:** Add the two scripts and the README.
- [ ] **Step 2:** Build a 10× site: `pnpm run build`, copy `app/dist` to a scratch folder, run the scaler over its `data/`, serve it with `npx serve@14 <folder> -l 4173`.
- [ ] **Step 3:** Run `BASE=http://localhost:4173/ THROTTLE=1 node scripts/perf/interact.mjs` on the current branch and keep the output as the baseline for A3 and B1.
- [ ] **Step 4:** Commit: `chore: keep the 10x benchmark scripts in the repo`.

---

## Part A: Activities list draws only the rows on screen

> "Today every row is drawn; at 10× that's about 120,000 page elements. Drawing only the visible rows (called windowing) is the real fix."

Use `@tanstack/react-virtual`. A hand-written window would need fixed row heights, and the rows are not fixed (see the findings). The library measures each rendered row, keys the measurements by activity id (so a sort does not mix them up), and scrolls to a row by index.

The cost: the browser's find-in-page no longer sees rows that are not drawn. The fix is to send Ctrl+F (Cmd+F on a Mac) to the page's own search box, which searches every row, drawn or not. A second press while the box is focused is left to the browser, so its find is still one more key away. Find opened from the browser menu is not caught, and the page's search does not match distances or times; both are accepted.

Not chosen: an invisible `hidden="until-found"` copy of each undrawn row's text, scrolled to on `beforematch`. Browsers disagree about it ([caniuse](https://caniuse.com/mdn-html_global_attributes_hidden_until-found)): Firefox lists only partial support before 148, and Safari is unsupported or partial. It also adds back one element per row, and when find lands on a copy, the real row is drawn over it, so the highlight is lost.

### Task A1: Pure window helpers

**Files:**
- Create: `app/src/ui/listWindow.ts`
- Test: `app/src/ui/listWindow.test.ts`

**Interfaces:**
- Produces: `withPinned(indexes: number[], pinned: readonly (number | null)[], count: number): number[]`: the union, ascending, without duplicates, nulls, or indexes outside `0..count-1`.
- Produces: `nextRowIndex(i: number, key: "ArrowDown" | "ArrowUp", count: number): number`: the row to focus, or `-1` for the search box (ArrowUp from row 0).

- [ ] **Step 1: Write the failing tests**

```ts
test("withPinned adds pinned rows in order, once", () => {
  expect(withPinned([10, 11, 12], [3, 11, null], 100)).toEqual([3, 10, 11, 12]);
  expect(withPinned([0, 1], [500], 100)).toEqual([0, 1]);
});
test("nextRowIndex stops at the last row and leaves the first for the search box", () => {
  expect(nextRowIndex(4, "ArrowDown", 5)).toBe(4);
  expect(nextRowIndex(3, "ArrowDown", 5)).toBe(4);
  expect(nextRowIndex(0, "ArrowUp", 5)).toBe(-1);
  expect(nextRowIndex(2, "ArrowUp", 5)).toBe(1);
});
```

- [ ] **Step 2:** Run `pnpm --filter app exec vitest run src/ui/listWindow.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4:** Run the test again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: window helpers for the Activities list`.

### Task A2: Window the list

**Files:**
- Modify: `app/package.json` (`pnpm --filter app add @tanstack/react-virtual@^3.14`)
- Modify: `app/src/ui/ActivitiesView.tsx:99-177` (refs, keyboard), `:292-329` (the list)
- Modify: `app/src/index.css:524-534` (remove `.activities__item`'s `content-visibility` rule and its comment)
- Test: `app/src/ui/ActivitiesView.test.ts`

**Interfaces:**
- Consumes: `withPinned`, `nextRowIndex` from Task A1.

- [ ] **Step 1: Write the failing tests** (add to `ActivitiesView.test.ts`; `render` gains a `visible` override)

```ts
test("draws only the first rows of a long list, and says how long it is", () => {
  const many = Array.from({ length: 500 }, (_, i) => record({ id: `r${i}`, name: `Run ${i}`, type: "Run" }));
  const html = render({ visible: many });
  expect(html.match(/data-row="/g)!.length).toBeLessThan(60);
  expect(html).toContain('aria-setsize="500"');
  expect(html).toMatch(/aria-posinset="1"/);
});
```

- [ ] **Step 2:** Run `pnpm --filter app exec vitest run src/ui/ActivitiesView.test.ts`. Expected: FAIL (500 rows drawn).
- [ ] **Step 3: Implement.** The decisions:
  - The scroll element is the page's `<main>` (it has `overflow-y: auto`); give it a ref.
  - `useVirtualizer({ count: rows.length, getScrollElement, estimateSize: () => 55, overscan: 8, getItemKey: (i) => rows[i].id, scrollMargin, initialRect: { width: 0, height: 900 }, rangeExtractor })`. `initialRect` is what makes the server-rendered tests draw the first rows.
  - `scrollMargin` is the list's top inside the scroll element: `list.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop`, measured in a layout effect and again when the column resizes (the lede can wrap).
  - `rangeExtractor = (range) => withPinned(defaultRangeExtractor(range), [focusIndex, openIndex], rows.length)`. `focusIndex` is the row holding keyboard focus (tracked with the list's `onFocus` and `onBlur`); `openIndex` is the previewed row. Pinning keeps the focused button mounted, so arrow keys work after the wheel scrolled it away, and keeps the preview's loaded state.
  - Keep the `<ol>` and `<li>` in normal flow, so the existing CSS still applies. The window is `padding-top` (first item's `start - scrollMargin`) and `padding-bottom` (`getTotalSize() - last item's end`) on the `<ol>`.
  - Each `<li>` gets `ref={virtualizer.measureElement}`, `data-index`, `aria-setsize={rows.length}` and `aria-posinset={index + 1}`.
  - Keyboard: replace `rowButtons()` with indexes. The current index comes from `document.activeElement.dataset.row` through a `Map` of id to index. To focus row `i`: `virtualizer.scrollToIndex(i)`, then focus `button[data-row="<id>"]` on the next animation frame, retrying until it is mounted. ArrowDown in the search box focuses row 0; `nextRowIndex` returning `-1` focuses the search box.
  - The preview's `scrollIntoView` effect stays as it is.
  - Find: extend the existing `"/"` key handler. Ctrl+F or Cmd+F (`e.key === "f"` with `ctrlKey` or `metaKey`, without `altKey` or `shiftKey`) calls `preventDefault`, then focuses and selects the search box, unless the box is already focused; in that case the handler does nothing and the browser's find opens. The placeholder gains the hint: "Search by name, place, type or date (Ctrl+F)", or "⌘F" when `navigator.platform` starts with "Mac".
- [ ] **Step 4:** Run the whole file. Expected: PASS, including the five existing tests.
- [ ] **Step 5: Check by hand on the 10× site**, desktop and a 390 px wide window:
  - Hold ArrowDown from the search box through 100 rows: focus never drops, the list follows.
  - Focus a row, scroll it far away with the wheel, press ArrowDown: the list returns to the next row.
  - Open a preview near the bottom of the screen: it scrolls into view. Sort by distance while it is open: no error, and the preview is still open when its row is scrolled to.
  - On the phone width, scroll down past rows with wrapped meta lines and back up: no jump.
  - Type a query while scrolled deep: the list shows its first matches, not an empty area.
  - Press Ctrl+F (Cmd+F on a Mac) while scrolled deep: the search box takes focus with its text selected. Press it again: the browser's find opens. On the map and Analytics pages, Ctrl+F still opens the browser's find.
- [ ] **Step 6:** Commit: `perf: draw only the Activities rows on screen`.

### Task A3: Measure

- [ ] **Step 1:** Rebuild the 10× site and run `ONLY=activities-open,activities-sort,activities-clear-search,activities-preview`.
- [ ] **Step 2:** Pass when `activities-open` reports under 4,000 nodes (baseline 119,946) and no long task over 200 ms (baseline 5,327 ms), and the other three steps report no long task over 100 ms. Put both sets of numbers in the PR description.

---

## Part B: Replay sends Mapbox only the routes in play

> "Each route is loaded into the map twice, and every route that finishes during replay costs a separate update. No fix has been tried yet, so it needs a prototype first."

**Design to prototype.** Keep the base source as it is. Replace the full-size `activities-active` source with two small sources that hold only a window of the timeline, the routes from the one drawing up to about half a second ahead:

- `replay-active`: the window's whole lines, with `lineMetrics: true`, drawn by the existing active layers (trimmed; feature-state `drawing`).
- `replay-recent`: the window's routes as the base source draws them (whole lines, or grade runs in Grade mode), drawn by two new layers painted exactly like the base layers at rest (feature-state `done`).

While the replay moves inside a window, only these small sources change: `drawing` moves on, finished routes get `done`. The base source is touched once per window: when the drawing route nears the window's end, in one frame set `pending: false` on the base source for every route finished since the last window, clear `done` for them, and call `setData` on both small sources with the next window, which starts at the drawing route. So the cost that grows with all routes happens about twice a second instead of every frame, and no route is loaded twice.

`replay-recent` must hold what the base holds, not whole lines: in Grade mode a layer has one `line-gradient`, so several finished whole lines could not each wear their own grades.

### Task B1: Baseline

- [ ] **Step 1:** On the 10× site, run `ONLY=replay` at 1× and 8× speed, three runs each. Record frames, p95, worst frame and long tasks.
- [ ] **Step 2:** Take a CPU profile of 4 s of replay on an unminified build (`vite build --minify false --outDir <scratch>`) and record Mapbox's top self-time functions. Expected at the top: `getState`, `bufferSubData`, `updatePaintArrays`.

### Task B2: Prototype the window (throwaway branch)

**Files:**
- Create: `app/src/replayWindow.ts`
- Modify: `app/src/MapView.tsx:36-49` (source and layer ids), `:398-402` (`applyActiveRoutes`), `:414-473` (`applyReplay`), `:672-776` (`installLayers`)
- Modify: `app/src/App.tsx:753-780` (pass `replaySpeed={speed}`)

**Interfaces:**
- Produces: `windowSize(routesPerSecond: number): number` = `clamp(ceil(routesPerSecond * 0.5), 32, 512)`.
- Produces: `windowFor(index: number, count: number, size: number, current: ReplayWindow | null): ReplayWindow`, where `ReplayWindow = { start: number; end: number }` covers timeline indexes `[start, end)`. It returns `current` while `index` is inside it and either `current.end === count` or `index < current.end - ceil(size / 4)`; otherwise `{ start: index, end: min(count, index + size) }`.
- `routesPerSecond = count / (totalDurationMs(count) / 1000) * speed`.

- [ ] **Step 1:** Implement the design above, the quickest way that works. No tests yet.
- [ ] **Step 2:** Run the Task B1 measurements on it.
- [ ] **Step 3:** Compare screenshots with `main` at 25%, 50% and 100% progress (seek with the scrubber) in Plain, Heat and Grade modes.

### Task B3: Decide

Pass bar at 10× on this machine, no CPU throttle: at 1× speed no frame over 50 ms and no long task over 100 ms in 5 s of playback; at 8× speed p95 frame under 34 ms. And the screenshots match `main`.

- [ ] **Pass:** go to Task B5.
- [ ] **Miss, with `getState` or `bufferSubData` on the base source still leading the profile:** try Task B4.
- [ ] **Miss for another reason:** stop and report the profile. The design needs rethinking, not tuning.

### Task B4: Fallback, only if B3 sends you here

Reveal finished routes on the base layers with a filter instead of feature-state: once per window, `setFilter` the base layers to the user's filter plus `["<", ["get", "ts"], <ts of the window's first route>]` (routes sharing that second stay in the window sources). A filter change rebuilds the tiles in a worker, off the main thread. It lands late, which is why replay moved away from filters before; here `replay-recent` covers the routes until it does, so clear `done` only after the map's next `idle`. Measure again against the pass bar.

### Task B5: Production (write this task's tests after B3 picks the design)

**Files:**
- Create: `app/src/replayWindow.ts`, `app/src/replayWindow.test.ts`
- Modify: `app/src/MapView.tsx`, `app/src/App.tsx`

- [ ] **Step 1: Write the failing tests** for `windowSize` and `windowFor`:

```ts
test("windowSize is half a second of routes, between 32 and 512", () => {
  expect(windowSize(10)).toBe(32);
  expect(windowSize(100)).toBe(50);
  expect(windowSize(5000)).toBe(512);
});
test("windowFor keeps a window until the last quarter, then starts one at the drawing route", () => {
  const w = { start: 0, end: 64 };
  expect(windowFor(40, 1000, 64, w)).toBe(w);
  expect(windowFor(48, 1000, 64, w)).toEqual({ start: 48, end: 112 });
  expect(windowFor(10, 1000, 64, { start: 500, end: 564 })).toEqual({ start: 10, end: 74 }); // scrubbed back
  expect(windowFor(990, 1000, 64, { start: 960, end: 1000 })).toEqual({ start: 960, end: 1000 }); // last window
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `replayWindow.ts`, then rebuild `applyReplay` on it. Also:
  - Remove `applyActiveRoutes` and its calls: the small sources are empty outside replay.
  - Scrubbing back sets `pending: true` again for the routes between the new index and the old one (the existing loop over `s.done` does this) and starts a window at the new index.
  - A new timeline (the filter changed mid-replay) and the theme swap's `style.load` both reset the window and rewrite the states from scratch.
  - Exiting replay empties both small sources and clears their states.
- [ ] **Step 4:** Run `pnpm --filter app run test`. Expected: PASS.
- [ ] **Step 5: Check by hand on the 10× site:** scrub backwards and forwards quickly; toggle a type row during replay; switch theme during replay; replay in Grade and Heat modes; exit at 50% and confirm the map looks as it did before replay. In each case no route is missing, late by more than a frame or two, or brighter than its neighbours (drawn twice).
- [ ] **Step 6:** Run the Task B1 measurements; put before and after in the PR description. Also record the time from page load to routes shown, which should drop because the second source is no longer filled.
- [ ] **Step 7:** Commit: `perf: replay feeds Mapbox a window of routes, not every route twice`.

---

## Part C: Load less up front

> "Analytics and Activities could start without waiting for `routes.json`." and "Fetch each city's lines only on 'Show on map'."

### Task C1: Analytics and Activities don't wait for routes

**Files:**
- Create: `app/src/ui/useRoutes.ts` (a load state like `useRouteProfiles.ts`: `{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; file: RoutesFile }`, fetched once at mount)
- Modify: `app/src/App.tsx:202-218` (the load effect), `:437-440` (`routeCoords`), `:717-750` (spinner, error chips, map mount)
- Modify: `app/src/ui/ActivitiesView.tsx:37` (`routes` may be `null`), `:301-308`, `:404`
- Test: `app/src/ui/ActivitiesView.test.ts`

**Interfaces:**
- `App`: the filter, places and zone limits are set as soon as `activities.json` and `places.json` arrive. `data` (the features) is built when both the routes and the activities are in; `joinActivities` runs inside a `try` in an effect, and a wrong version becomes the routes error.
- A routes error no longer fails the site. On the map page it shows the alert chip "Couldn't load the routes: …"; Analytics and Activities work without routes.
- `ActivitiesView` takes `routes: ReadonlyMap<…> | null`; `null` means still loading. A row then says "No route" only when the record has no `gps` channel.

- [ ] **Step 1: Write the failing tests** (the file's `render` helper gains a `routes` override that may be `null`)

```ts
test("while the routes load, a row with GPS doesn't claim to have no route", () => {
  const html = render({ routes: null, visible: [record({ id: "a", type: "Run", channels: ["gps"] })] });
  expect(html).not.toContain("No route");
});
test("while the routes load, a row without GPS already says so", () => {
  const html = render({ routes: null, visible: [record({ id: "a", type: "Run", channels: [] })] });
  expect(html).toContain("No route");
});
```

- [ ] **Step 2:** Run them. Expected: FAIL (type error on `routes: null`).
- [ ] **Step 3:** Implement `useRoutes`, the split load in `App`, and the `null` case in `ActivitiesView`.
- [ ] **Step 4:** Run `pnpm run typecheck && pnpm --filter app run test`. Expected: PASS.
- [ ] **Step 5: Check by hand** with `routes.json` delayed 5 s (DevTools request throttling, or a Playwright `page.route` that waits): opening on `/analytics` draws the charts at once; opening on Activities lists the rows, and an open preview gains its track when the routes arrive; the map page shows its spinner until then. With `routes.json` blocked: Analytics and Activities work, the map page shows the routes error.
- [ ] **Step 6:** Commit: `perf: Analytics and Activities start without the routes`.

### Task C2: City route lines one city at a time

The OSRM cache the build script reads (`scripts/data/.city-distances-cache.jsonl`) is not on this machine, so the split is made from the committed file, without the network.

**Files:**
- Modify: `scripts/city-types.ts`, `app/src/types.ts:140-175` (`EncodedCityRoute` is `{ m }`; new `CityRouteFile = { v: 1; cycling?: string; walking?: string }`)
- Modify: `scripts/build-city-distances.ts` (`PAYLOAD_VERSION = 2`; write the index and `app/public/city-routes/<id>.json`; new `--resplit` flag)
- Modify: `app/src/cities.ts` (`CITY_PAYLOAD_VERSION = 2`; `CityRoute` is `{ m }`; new `loadCityRoute`)
- Modify: `app/src/App.tsx:268-279` (`cityRoute`)
- Modify: `app/public/city-distances.json`; Create: `app/public/city-routes/*.json` (253 files)
- Test: `scripts/build-city-distances.test.ts`, `app/src/cities.test.ts`

**Interfaces:**
- Produces (build): `splitPayload(v1: CityDistancePayloadV1): { index: CityDistancePayload; routes: Map<number, CityRouteFile> }`. The index keeps every field except `poly`. A city with no route in either profile gets no file.
- Produces (build): `tsx scripts/build-city-distances.ts --resplit` reads a v1 `city-distances.json`, writes the v2 index and the route files, and makes no request. On a file that is already v2 it exits with an error.
- Produces (app): `loadCityRoute(id: number, profile: Profile): Promise<[number, number][]>`: fetches `city-routes/<id>.json`, decodes that profile's line to `[lng, lat]`, caches per `id:profile`, forgets a failed load, and rejects when the file has no line for the profile or fewer than 2 points.
- `App`: when the shown city changes, load its line; `cityRoute` is `null` until the line for the current key is in. A failed load leaves the panel as it is, draws no line, and logs a warning (as `fetchPlaces` does).

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/build-city-distances.test.ts
test("splitPayload moves the lines out and keeps the distances", () => {
  const { index, routes } = splitPayload(v1({ id: 7, cycling: { m: 1000, poly: "abc" }, walking: null }));
  expect(index.v).toBe(2);
  expect(index.cities[0].cycling).toEqual({ m: 1000 });
  expect(routes.get(7)).toEqual({ v: 1, cycling: "abc" });
});
// app/src/cities.test.ts
test("decodeCities reads a v2 index and refuses v1", () => {
  expect(decodeCities(v2Index).cities[0].cycling).toEqual({ m: 1000 });
  expect(() => decodeCities({ ...v2Index, v: 1 })).toThrow(/version 1/);
});
```

- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `pnpm exec tsx scripts/build-city-distances.ts --resplit`.
- [ ] **Step 4:** Run `pnpm run test:all`. Expected: PASS. Check `gzip -9c app/public/city-distances.json | wc -c` is about 10,000 (was 301,143).
- [ ] **Step 5: Check by hand:** on Analytics, "Show on map" for the ride comparison and for the on-foot one each draw their dashed route and fit it; narrowing the date range moves the route to the new city; the network panel shows one `city-routes/<id>.json` per city shown.
- [ ] **Step 6:** Commit: `perf: fetch a city's route only when it is shown`.

### Not now: splitting routes, activities and profiles

At 541 activities the three files total 259 KB compressed, and the map needs every year in the default date range, so a split by year would save nothing on first load. Revisit when `routes.json` passes about 500 KB compressed (roughly 1,500 routed activities). Then split by year, newest first, each file named with a content hash: a returning visitor re-fetches only the current year, and the map can draw the newest year while the rest load.

Vector tiles are not recommended at any size this app will see. Replay's draw-on (`line-trim-offset`), the Grade runs, the route fits and the preview sketches all need whole routes as GeoJSON in the page; tiles cut routes at tile edges.

---

## Part D: Smaller database, faster refresh

> "45% of it is OpenStreetMap reference points that rarely change. … Moving those points to their own file roughly halves each transfer." and "4.4 s of that is re-reading every activity's recorded data to find its highest point. Storing that point per activity removes most of the cost."

One PR, one schema bump (v6).

**Where the OSM points go.** They are derived entirely from the archive's snapshots (`osm/<CC>/<stamp>-<sha12>.json`), so the file is named by the snapshots it was built from: `derived/osm-points/v1-<hash>.sqlite`, where the hash covers the newest snapshot key of each country. The name changes only when `places:update` stores a new snapshot. The file is written once and never changed, so it needs no conflict handling, and a machine that has it cached never downloads it again. Only writers need it (the refresh); the deploy and the MCP server never fetch it.

### Task D1: Store each activity's highest point (schema v6)

**Files:**
- Modify: `ingest/db.py:22` (`SCHEMA_VERSION = 6`), `:31-71` (four columns on `activities`: `top_lat REAL, top_lon REAL, top_ele REAL, top_climb REAL`)
- Modify: `ingest/merge.py:138-215` (`recompute_activity`)
- Test: `ingest/tests/test_merge.py`, `ingest/tests/test_db.py`

**Interfaces:**
- Produces: after `recompute_activity`, the four columns hold `geometry.track_top(st["lat"], st["lon"], st["altitude"])` computed from the decoded streams it already loads, or four NULLs when there is no top (no altitude, under 30 samples, or under 50 m of climb). Computing from the decoded streams gives exactly the values `grouping._top` computes today, so no place moves.

- [ ] **Step 1: Write the failing tests**

```python
def test_recompute_stores_the_top(conn_with_climb):       # 60 samples rising 300 m to the midpoint
    row = conn_with_climb.execute("SELECT top_lat, top_lon, top_ele, top_climb FROM activities").fetchone()
    lat, lon, alt = (codec.decode(c, b) for c, b in zip(("lat", "lon", "altitude"), stream_blobs(conn_with_climb)))
    assert tuple(row) == dataclasses.astuple(track_top(lat, lon, alt))

def test_recompute_stores_no_top_for_a_flat_track(conn_with_flat):
    assert tuple(conn_with_flat.execute("SELECT top_lat, top_ele FROM activities").fetchone()) == (None, None)
```

- [ ] **Step 2:** Run `<venv>/bin/python -m pytest ingest/tests/test_merge.py -q`. Expected: FAIL, no such column.
- [ ] **Step 3:** Add the columns, bump the version, and set the four values in `recompute_activity`.
- [ ] **Step 4:** Run `pnpm run test:py`. Expected: PASS, apart from tests that pin schema version 5; update those.
- [ ] **Step 5:** Commit: `feat: store each activity's highest point (schema v6)`.

### Task D2: The refresh reads the stored point

**Files:**
- Modify: `ingest/grouping.py:38-67` (delete `_top`; `load_tracks` selects from `activities` only)
- Modify: `ingest/tests/mcp_fixture.py:18-45` (`_insert_activity` fills the four columns from `track_top` over the encoded-then-decoded track)
- Test: `ingest/tests/test_grouping.py`

- [ ] **Step 1: Write the failing test**

```python
def test_load_tracks_needs_no_streams(conn):
    insert_activity(conn, "h1", "Hike", "2025-05-01T07:00:00+00:00", line((46.0, 14.5), 0, 3000, 60), alts=climb_alts(60, 300))
    before = load_tracks(conn)[0].top
    conn.execute("DELETE FROM streams")
    assert before is not None and load_tracks(conn)[0].top == before
```

- [ ] **Step 2:** Run it. Expected: FAIL (`top` is None once the streams are gone).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm run test:py`. Expected: PASS.
- [ ] **Step 5:** Commit: `perf: the refresh reads each activity's stored highest point`.

### Task D3: OSM points leave the database

**Files:**
- Modify: `ingest/db.py:204-213` (remove `osm_points` and `idx_osm_points_lat`) and its docstring
- Modify: `ingest/archive.py` (three methods on `LocalArchive` and `RemoteArchive`, and the `Archive` protocol)
- Modify: `ingest/osm.py` (`apply_osm` becomes `build_points_file`; new `points_file`; `main`)
- Modify: `ingest/refresh.py:54-58`, `:108-127`; `ingest/writer.py:138-147`; `ingest/rebuild.py:13`, `:68`
- Test: `ingest/tests/test_osm.py`, `test_archive.py`, `test_refresh.py`, `test_writer.py`, `test_rebuild.py`

**Interfaces:**
- Produces (`archive`): `newest_osm_keys() -> dict[str, str]` (country to its newest snapshot key; the remote one lists the store and downloads nothing).
- Produces (`archive`): `get_derived(key: str) -> str | None`: the local path of `derived/<key>`. The remote one returns the cached file, else downloads it into the cache; `None` when the store has no such key.
- Produces (`archive`): `put_derived(key: str, path: str) -> None`: stores the file under `derived/<key>`, then deletes the other files in the same folder, in the store and in the cache. The remote one puts with `if_none_match="*"` and treats `PreconditionFailed` as done (another machine built the same file).
- Produces (`osm`): `points_file_name(keys: Iterable[str]) -> str` = `"v1-" + sha256("\n".join(sorted(keys)))[:16] + ".sqlite"`.
- Produces (`osm`): `build_points_file(snapshots: dict[str, bytes], dest: str) -> dict[str, int]`: writes `osm_points(osm_id TEXT PRIMARY KEY, kind, name, lat, lon, ele, country) WITHOUT ROWID` with `PRAGMA user_version = 1`, countries in sorted order with `INSERT OR REPLACE` (a border feature keeps the later country), to a temp file renamed into place. Returns points per country.
- Produces (`osm`): `points_file(archive) -> str | None`: `None` when the archive has no snapshots; else `get_derived` of the named file, and when that is missing, build it from `archive.list_osm()` and `put_derived` it. Any store error is raised.
- Changes: `refresh_file(path, osm_path: str | None = None, log=print)`; `_refresh(conn, osm_path)` reads the points from that file opened read-only, or uses an empty index when `osm_path` is `None`.
- Changes: `writer.run`'s `try_refresh` calls `refresh_file(path, osm.points_file(archive))` inside its `try`, so a store error counts as a failed refresh: the work is saved and the run exits with 7. `osm` is imported inside `run`, as `refresh` is.
- Changes: `osm.main` stores the snapshots, then `work` only opens the database for writing, and the per-country counts printed come from the points file. `rebuild` no longer touches OSM.

- [ ] **Step 1: Write the failing tests**

```python
# test_osm.py
def test_points_file_name_follows_the_snapshots():
    assert points_file_name(["osm/SI/a.json"]) == points_file_name(["osm/SI/a.json"])
    assert points_file_name(["osm/SI/a.json"]) != points_file_name(["osm/SI/b.json"])

def test_build_points_file_keeps_a_border_feature_once(tmp_path):
    counts = build_points_file({"SI": snapshot(PEAK), "AT": snapshot(PEAK)}, str(tmp_path / "p.sqlite"))
    assert counts == {"AT": 1, "SI": 1}
    assert rows(tmp_path / "p.sqlite") == [("node/1", "SI")]

def test_points_file_is_downloaded_once_and_never_rebuilt(tmp_path):
    store = SpyStore(); a = remote(store, tmp_path / "a"); a.put_osm("SI", snapshot(PEAK), fetched_at=T0)
    first = points_file(a)                      # built here, stored under derived/osm-points/
    b = remote(store, tmp_path / "b")           # another machine, empty cache
    store.gets.clear()
    assert rows(points_file(b)) == rows(first)
    assert [k for k in store.gets if k.startswith("osm/")] == []     # the snapshots were not fetched
    store.gets.clear(); points_file(b)
    assert store.gets == []                                           # cached

def test_a_new_snapshot_replaces_the_stored_points_file(tmp_path): ...   # one key under derived/osm-points/ afterwards

# test_refresh.py
def test_refresh_without_a_points_file_uses_fallback_names(db_path): ...   # refresh_file(db_path) -> "Top at 600 m"

# test_writer.py
def test_run_exits_7_and_keeps_the_names_when_the_points_file_cannot_be_fetched(...):
    # the store raises on get("derived/…"): the work is uploaded, SystemExit code 7, the places table unchanged
```

- [ ] **Step 2:** Run `pnpm run test:py`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. In `test_refresh.py` replace the `INSERT INTO osm_points` helper with one that builds a points file; replace `test_rebuild_restores_osm_points_from_archive` with a test that a rebuilt database has no `osm_points` table; drop `osm_points` from the table list at `test_writer.py:362`.
- [ ] **Step 4:** Run `pnpm run test:py`. Expected: PASS.
- [ ] **Step 5:** Commit: `perf: OSM points live in their own file, not in the database`.

### Task D4: The daily snapshot is a copy inside R2, not a second upload

**Files:**
- Modify: `ingest/objstore.py` (`copy` on the protocol, `MemoryStore`, `S3Store`)
- Modify: `ingest/writer.py:193`
- Test: `ingest/tests/test_objstore.py`, `test_writer.py`, `test_objstore_live.py`

**Interfaces:**
- Produces: `ObjectStore.copy(src: str, dst: str, *, if_match: str | None = None) -> None`. `S3Store` calls `copy_object` with `CopySourceIfMatch`; a failed condition raises `PreconditionFailed`.
- Changes: after a successful upload, `writer.run` calls `store.copy(DB_KEY, snapshot_key, if_match=<etag the put returned>)`. On `PreconditionFailed` it skips the snapshot: another writer has already replaced the database and will take the snapshot itself.

- [ ] **Step 1: Write the failing tests**

```python
def test_copy_duplicates_an_object_and_honours_if_match():
    s = MemoryStore(); etag = s.put("a", b"x"); s.copy("a", "b", if_match=etag)
    assert s.get("b")[0] == b"x"
    with pytest.raises(PreconditionFailed): s.copy("a", "c", if_match='"other"')

def test_run_takes_the_snapshot_by_copy(...):    # the spy store sees one put (DB_KEY) and one copy, no second put
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Add a live copy round trip to `test_objstore_live.py` and run it once against R2: this is the one place the plan relies on R2 behaviour not yet used in this repo.
- [ ] **Step 4:** Run `pnpm run test:py`. Expected: PASS.
- [ ] **Step 5:** Commit: `perf: take the daily database snapshot with a copy inside R2`.

### Task D5: Docs, demo database, rollout

**Files:**
- Modify: `docs/data-pipeline.md` (Places and same routes, Rebuild), `docs/publishing.md`, `ingest/mcp_server/freshness.py:3-5` (the "44 MB" line)
- Modify: `data/demo/activities.sqlite` (`pnpm run build:demo`)

- [ ] **Step 1:** Update the docs: where the OSM points live, that `places:update` no longer changes the database's size, and that changing `track_top`'s constants needs a rebuild to take effect.
- [ ] **Step 2:** Regenerate the demo database and run `pnpm run test:all`.
- [ ] **Step 3:** Before merging, on a copy of the real database: `sqlite3 copy.sqlite ".dump places route_groups activity_groups" > before.sql`.
- [ ] **Step 4:** Merge, then at once run `PYTHON_BIN=<venv>/bin/python pnpm run rebuild` on this machine. The first writer after the merge rebuilds the database either way; the daily fetch at 04:17 UTC must not be the one, because a CI runner would first download the whole archive.
- [ ] **Step 5:** Verify:
  - `ls -l data/activities.sqlite` is about 45 MB (was 82.8 MB).
  - The same three tables dumped from the new database equal `before.sql`.
  - On a copy of the new database, time `refresh_file(copy, points_file_path)` from a Python prompt: about 3.5 s here (was 5.8 s), and `rows_changed` is 0.
  - The R2 bucket holds one object under `derived/osm-points/`.
  - The next daily fetch and deploy succeed.
- [ ] **Step 6:** Commit: `docs: OSM points file, stored highest point, snapshot copy`.

**Expected after Part D:** a changed write moves about 90 MB instead of 249 MB (pull 45, push 45, snapshot 0), plus 22 MB once per machine for the points file, which CI pays daily unless its cache folder is kept with `actions/cache`. The deploy and the MCP sync pull 45 MB instead of 83 MB. The refresh drops from 5.8 s to about 3.5 s here.

---

## Seen while measuring, not planned here

- **Compress the database in transit.** zstd level 3 takes the 45 MB file to 19 MB. It means changing `ci_db.sh` (which uses `aws s3 cp`) and the MCP freshness check (which compares R2's etag with the local file's MD5), and Python's built-in zstd needs 3.14 while CI runs 3.12.
- **Raw payloads.** `daily_stats.raw` (9.8 MB) and `activity_sources.summary_json` (6.2 MB) will be 35% of the smaller database, and both exist in the archive.
- **Grouping will not scale to 10×.** `_routes` compared 23,578 pairs for 452 tracks (1.0 s). That count grows roughly with the square of the activities.
- **Loading the OSM points** is the next cost in the refresh (1.8 s for 328,165 points, of which a refresh looks up about 730 places).
