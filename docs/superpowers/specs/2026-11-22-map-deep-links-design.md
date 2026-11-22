# Map deep links

Issue #23 §4 (Map parity), last item: "Deep links reproduce map state."

## Intent

Opening a copied URL, or reloading, shows what the person was looking at: the same
Activity filter, selected activity (and open same-route group), color mode, camera and
page. The site is a static SPA, so all of it lives in the URL.

## Goals, non-goals, anti-goals

- Goals: filter (types, date range, place), selected activity, same-route group open,
  color mode, camera (center + zoom), page. Old URLs (bare map, `#analytics`,
  `#activities`) keep working.
- Non-goals: replay state, theme (a local preference), the Activities page's search and
  sort, a shown city route, panel collapse, the month-isolation memory. Bearing and pitch
  are not encoded: rotation and pitch are disabled on the map.
- Anti-goals: extra route redraws or replays, the flicker fixed in #13 / #43, a camera
  jump on load when the URL names a camera, a busy URL on the default map, a crash on a
  stale or hand-edited link.

## Approaches

1. **Query string for state, hash for the page (picked).** `useView` already owns the
   hash and keeps `location.search` when it pushes, so the two never collide. A new writer
   owns the search and keeps the current hash. Old links have no search: defaults.
2. Everything in the hash (`#analytics?types=…`). Needs `useView`'s matching to change
   and mixes two owners in one string; no gain on a static host.
3. Mapbox's own `hash` option for the camera. Owns the whole hash (breaks page routing)
   and covers only the camera.

## URL format (v1)

`/?types=Run,Ride&from=2023-04&to=2024-10&place=<id>&activity=<id>&group=1&color=grade&map=12.40/46.05690/14.50580#analytics`

| Key | Value | Omitted when | Invalid / unknown |
|---|---|---|---|
| `types` | type names, sorted, comma-separated; empty = none on | the default type set | unknown names dropped; none left → default |
| `from`, `to` | `YYYY-MM` | the data's first / last month | malformed → default; clamped to the data; from > to → both default |
| `place` | place id | no place | not in places.json → none |
| `activity` | activity id | nothing selected | not in activities.json → none |
| `group` | `1` | route table shut, or no activity | ignored without a valid activity on a route |
| `color` | color mode (`type`, `recency`, `grade`, `speed`, `heat`) | `uniform` | unknown → `uniform` |
| `map` | `zoom/lat/lng`, 2 / 5 / 5 decimals (OSM order) | the camera hasn't left the opening frame | malformed or out of range → the home fit |

- No `v` means v1. A `v` other than `1` is a format this build doesn't know: the whole
  URL falls back to defaults. Unknown keys are ignored, so later keys can be added.
- Values are written with `encodeURIComponent`, then `,` and `/` are put back so lists
  and the camera stay readable.
- An omitted `to` follows the data: a link made on the latest month keeps showing the
  latest month as new activities arrive.

## History

- Switching page pushes an entry (as today).
- Everything else (filter, selection, group, color, camera) replaces the current entry,
  debounced (300 ms), and flushed on `pagehide` so a fast reload keeps the last change.
  Selecting an activity does not push: clicking through routes shouldn't make Back walk
  through every one, and Back keeps meaning "previous page".
- Back/forward still changes only the page (`useView`'s popstate, untouched). The state
  is app state, not history: after a popstate the writer rewrites the entry's search with
  the current state, so the address bar always matches the screen.
- Nothing is written until the activities are loaded, so an incoming link is never
  overwritten with defaults while the data loads.

## Load

- The color mode is read at once (no data needed).
- When activities.json and places.json are in, the filter is created from the URL in
  the same update that creates it today, together with the selection and group, so the
  first render with data is already the linked state: no second filter pass.
- The map mounts when the routes are in (as today). A URL camera becomes the map's
  starting camera: it skips the home fit and the fly-to on the linked selection, and the
  hold ends when the selection changes. Without a URL camera, a linked selection flies to
  its route as an activity opened from the Activities page does.
- The camera reaches the URL from the map's `moveend`, as a ref, never as React state,
  so a pan re-renders nothing. A camera equal (at URL precision) to the opening frame
  is not written, so a resize doesn't dirty a clean URL.

## Code shape

- `app/src/urlState.ts` (pure, `urlState.test.ts`): parse / format the search string,
  the app state → URL state (defaults omitted), and URL state + loaded data → filter,
  selection and group (validated).
- `app/src/ui/useUrlSync.ts`: the debounced writer, popstate and pagehide handling.
- `App.tsx`: initial state from the URL; one effect hands the state to the writer.
- `MapView.tsx`: `initialCamera` and `onCameraChange` props.
- `activityFilter.ts`: `defaultTypes()` shared by `createActivityFilter` and the URL.
