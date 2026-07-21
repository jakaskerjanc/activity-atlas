# Trace Atlas — implementation design

Restyle the existing Strava-on-maps app into the "Trace Atlas" activity-atlas UI,
wired to the real Mapbox GL map and real GeoJSON activities. Source design:
`Trace Atlas.dc.html` (Claude Design). No new data layer — same
`ActivityFeatureCollection` contract already produced by the pipeline.

## Data contract (unchanged)

`app/public/activities.geojson` — `FeatureCollection<LineString, ActivityFeatureProps>`:

```
id: number
name: string
type: string            // Strava sport_type, filter key
ts: number              // epoch seconds
start_date: string
distance: number        // meters
moving_time: number     // seconds
elevation_gain: number  // meters
```

## Decisions

- **Map**: keep Mapbox GL with the existing `dark-v11` style as-is (already dark). Do
  NOT restyle the base map.
- **Animation**: fade-in on load + REPLAY button re-triggers it. No per-track
  draw-in / stroke-dashoffset (too costly on Mapbox).
- **Interaction**: full hover + click. Hover highlights one track and dims others;
  click selects a track and flips the right panel to that activity's stats.
- **Layout**: Float only (glass panels). The mock's Split/Stack switcher is dropped (YAGNI).
- **Footer note**: dropped (the mock's "MOCK DATA" line is not carried over).
- **Accent**: `#ff6b3d`. Font: JetBrains Mono for mono/labels; Helvetica/Arial for body.

## Components

### `App.tsx` (top-level wiring)
Loads GeoJSON, derives:
- `availableTypes` (sorted unique `type`)
- `tsMin` / `tsMax` across all features (for date-range slider domain)

Owns state:
- `filter: FilterState` (existing)
- `selectedId: number | null`, `hoverId: number | null`
- `panelsHidden: boolean`
- `replayKey: number`

Passes selection/hover/replay to `MapView`; passes derived view-models to panels.
Renders: `MapView`, `Header`, `LeftPanel`, `RightPanel`, `PanelsToggle`, scale bar.

### `MapView.tsx` (Mapbox owner — keeps data/filter contract)
- Two line layers for the Trace look: a wide low-opacity **glow** line and a crisp
  **core** line, both `#ff6b3d`, rounded caps/joins.
- **Hover**: `mousemove` / `mouseleave` on the core layer → `onHover(id | null)`.
  Active/dim styling driven by a Mapbox `case` expression comparing `["get","id"]`
  to the active id (hoverId ?? selectedId): active = brighter + wider, others dimmed.
- **Click**: click on a track → `onSelect(id)`. Click on empty map → clear selection
  and hide panels (mock's "click map to hide panels" behavior).
- **Fade-in + replay**: on map load and whenever `replayKey` changes, animate the two
  layers' `line-opacity` from 0 to target over ~1.2s (requestAnimationFrame driving
  `setPaintProperty`). Respects `prefers-reduced-motion` (jump straight to target).
- Existing behaviors kept: fit-to-data bounds, `setData` on data change,
  `setFilter(buildFilter(filter))` on filter change.

### `ui/Header.tsx`
TRACE / "Activity Atlas" wordmark with accent chip + REPLAY button (`onReplay`).

### `ui/LeftPanel.tsx`
- **Activity Types**: one row per `availableType` — colored dot, label, live count
  (features of that type within the current date window). Toggle → updates
  `FilterState.types`.
  - Reconciliation with `buildFilter` ("empty `types` = show all"): the panel treats
    `types === []` as **all types on** for display. Toggling a type off materializes
    the explicit remaining-on list; toggling such that every type is on again collapses
    back to `[]`. Net effect: all-on and all-selected both render everything, matching
    the mock's default where every type starts enabled.
- **Date Range**: two range sliders over the real `[tsMin, tsMax]` domain →
  `FilterState.from` / `FilterState.to`. Labels show formatted real dates. Sliders
  clamp so `from <= to`.

### `ui/RightPanel.tsx`
- **No selection**: aggregate header ("All Activities" + date-window subtitle) and 4
  stat cards for the current filter — count, total km, total elevation, total moving time.
- **Selection**: the activity's name + "type · date" subtitle, "✕ ALL" clear button
  (`onClearSelection`), and 4 cards — distance km, moving time, elevation, and
  pace `/km` (foot-based types) or speed `km/h` (wheel/other).
- Shows "click a track" hint when nothing is selected.

### `ui/PanelsToggle.tsx`
"☰ PANELS" restore button, shown only when `panelsHidden` — calls `onShowPanels`.

### `format.ts` (pure, unit-tested)
`metersToKm`, `formatDuration(sec)` → "1h 4m", `pacePerKm`, `speedKmh`,
`formatDate(ts)`, `isFootBased(type)`.

### `stats.ts` (pure, unit-tested)
- `aggregate(features)` → `{ count, totalKm, totalElevation, totalMovingTime }`.
- `activityStats(feature)` → the 4-card view-model (distance/time/elevation/pace-or-speed).

### `index.css`
Font import, range-input thumb + track styling (accent thumb w/ glow), scrollbar,
`fadeUp` keyframe for the panels-toggle entrance.

## Data flow

`App` holds all state. `MapView` receives `data + filter + selectedId + hoverId +
replayKey`, emits `onHover`, `onSelect`, `onClearAndHide`. Panels receive derived
view-models (types w/ counts, date labels, stat cards) and emit filter/selection/
replay/visibility changes. `stats.ts` + `format.ts` are pure and shared.

## Testing

- Unit tests (Vitest) for `format.ts` and `stats.ts` — deterministic, no React/Mapbox.
- Map + panel wiring verified by running the app (Mapbox interaction not unit-tested).

## Out of scope

Layout switcher, footer note, Mapbox base-style changes, real Strava connection,
per-track draw-in animation.
