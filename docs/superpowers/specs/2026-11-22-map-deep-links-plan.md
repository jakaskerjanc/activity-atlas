# Map deep links: plan

Design: `2026-11-22-map-deep-links-design.md`.

1. `activityFilter.ts`: export `defaultTypes(availableTypes)`; `createActivityFilter`
   uses it. Existing tests stay green.
2. `urlState.test.ts` first, then `urlState.ts`:
   - `parseUrlState(search)` / `formatUrlState(state)`: syntax only (months, camera,
     color, lists, version), invalid values dropped.
   - `urlStateOf(app)`: app state → URL state, defaults omitted.
   - `filterFromUrl(filter, state, placeIds)` and `selectionFromUrl(state, filter)`:
     validated against the loaded data.
   - `sameCamera(a, b)` at URL precision.
   - Tests: round trips, defaults omitted (default state → empty search), invalid input
     (unknown type / place / activity, malformed months and camera, out-of-range
     numbers, unknown `v`), readable output (commas and slashes unescaped).
3. `ui/useUrlSync.ts`: debounced `replaceState` of the search (keeps pathname + hash),
   flush on `pagehide`, rewrite after `popstate`, no write until there is state.
4. `MapView.tsx`: `initialCamera` (start there, skip `frameHome`, hold `fitSelected`
   while the selection is still the linked one) and `onCameraChange` (on `moveend`,
   null while at the opening frame).
5. `App.tsx`: read the URL once; color mode from it at once; filter + selection + group
   from it in the data-load update; selected route from the activity record so a linked
   group survives until the routes load; hand the state to the writer; camera via a ref.
6. Verify: `pnpm --filter app test`, `pnpm --filter app build`, root typecheck, and a
   browser check with real data (load a deep link, reload, back/forward, default URL
   stays bare).
7. Commit, push, PR against `main` referencing #23.
