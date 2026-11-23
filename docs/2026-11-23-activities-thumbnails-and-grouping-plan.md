# Activities page: route thumbnails and grouping, implementation plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Executed
> inline (superpowers:executing-plans), test-first.

**Goal:** a 36 px route thumbnail left of each Activities row's name, and a Group
control (None | Week | Month) that splits the list under headers with subtotals and
gap lines for empty stretches.

**Architecture:** two pure modules carry the rules, each with its own tests:
`trackSketch.ts` gains a cached thumbnail path; a new `activityGroups.ts` turns the
sorted, searched activities into the virtualized list's items (rows, headers, gaps).
`ActivitiesView.tsx` draws those items with the existing virtualizer; keyboard
navigation keeps counting rows, not items. Group state lives in App beside the sort.

**Tech stack:** React 19, TanStack Virtual, Vitest (`pnpm --filter app run test`).

**Spec:** `docs/2026-11-23-activities-thumbnails-and-grouping-design.md`

## Global constraints

- Thumbnail: 36 px, inline SVG from `trackSketch`, the activity's type color, north
  up, no basemap. No route, or routes loading: an empty 36 px slot.
- Group: None (default), Week, Month. Weeks start on Monday. Group by the date the row
  shows (`formatDate(a.ts)`, UTC).
- Header: title, then `N activities · X km · Hh Mm · Y m`; subtotals count only the
  listed rows. Phone: the totals wrap under the title.
- Empty weeks/months between two groups: one line, `N weeks without activities`
  (`… without matches` while searching).
- Non-date sort: groups in date order (newest first unless the sort is date
  ascending), rows sorted inside each group.
- The group choice is kept where the sort is: App state (not the URL; the sort isn't
  in the URL either).
- Performance: only drawn rows compute a thumbnail, once per route array; one style
  write per row (the type color as a CSS variable shared by the dot and the line).

## Review focus

1. A long rest (months) between two groups shows one gap line, never one line per
   empty period. → `activityGroups` test "one line per stretch".
2. A week that crosses a month or year boundary keys by its Monday, and Sunday 23:59
   UTC stays in the week before Monday. → `activityGroups` test on week keys.
3. Unknown distance / time / climb are left out of a subtotal, and a total with no
   known value is not shown as "0 km". → `activityGroups` totals test.
4. Arrow keys from the last row of one group go to the first row of the next, never
   to a header. → `listWindow`/view test that focus order counts rows.
5. Opening a preview with grouping on keeps the open row pinned (its item index, not
   its row index). → view test: open row rendered with grouping on.

---

### Task 1: Route thumbnails

**Files:** modify `app/src/trackSketch.ts`, `app/src/trackSketch.test.ts`,
`app/src/ui/ActivitiesView.tsx`, `app/src/ui/ActivitiesView.test.ts`, `app/src/index.css`.

**Produces:** `THUMB_SIZE = 36`; `thumbnailPath(coords): string | null` — the route
fitted into a 36×36 box (pad 3, step 1 px), cached in a `WeakMap` keyed by the coords
array, so it is computed once per route per data load.

- [ ] Test: `thumbnailPath` returns a path whose points all lie inside 3..33 on both
  axes; a one-point route gives null; a second call on the same array returns the
  cached value (assert by mutating the array after the first call: the result
  doesn't change).
- [ ] View test: a routed row draws `<svg class="activities__thumb"…><path d="M…`; a
  row without a route still has the empty slot (`activities__thumb` with no path).
- [ ] Implement: the row's `activities__what` becomes thumb + text; the row sets
  `--type` once (dot and stroke read it). Preview left padding grows by 36 px + gap.
- [ ] Run `pnpm --filter app run test`, commit `feat: route thumbnails in the Activities list`.

### Task 2: Grouping

**Files:** create `app/src/activityGroups.ts`, `app/src/activityGroups.test.ts`;
modify `app/src/ui/ActivitiesView.tsx`, `ActivitiesView.test.ts`, `app/src/App.tsx`,
`app/src/index.css`, `CONTEXT.md`.

**Produces:**

```ts
export type Grouping = "none" | "week" | "month";
export const DEFAULT_GROUPING: Grouping = "none";
export interface GroupTotals { count: number; distance?: number; time?: number; climb?: number }
export type ListItem =
  | { kind: "row"; activity: ActivityRecord; row: number }        // row: position among rows
  | { kind: "header"; key: number; grouping: "week" | "month"; totals: GroupTotals }
  | { kind: "gap"; key: number; grouping: "week" | "month"; periods: number };
export function periodKey(ts: number, grouping: "week" | "month"): number; // Monday's UTC day number, or monthIndex
export function listItems(sorted: readonly ActivityRecord[], grouping: Grouping, sort: Sort): ListItem[];
export function groupTitle(item: header item): string; // "Week of Nov 17, 2026" / "November 2026"
export function gapLabel(item: gap item, searching: boolean): string; // "2 weeks without activities"
export function totalsLabel(t: GroupTotals): string; // "12 activities · 98 km · 11h 40m · 2,310 m"
```

`listItems` keeps the given order inside each group (so the sort applies inside
groups), and orders groups newest first unless `sort` is date ascending; `grouping
"none"` gives only rows.

- [ ] Tests: none → rows only, in order; month groups with totals; weeks start Monday
  (Sun 23:59 UTC vs Mon 00:00); a distance sort keeps groups newest first with rows by
  distance inside; date-ascending sort puts groups oldest first; one gap item per
  empty stretch with the right count, none between adjacent periods; unknown values
  left out of totals and labels.
- [ ] View tests: grouping "month" renders a header with the totals and keeps
  `aria-setsize` = number of activities; the Group control shows three pressed-state
  buttons (desktop) / a select (phone).
- [ ] Implement: items feed the virtualizer (`estimateSize` by kind, keys `h:`/`g:`/id);
  `indexOf` maps id → item index for pinning; keyboard steps over `rowItems` (row →
  item index). App holds `grouping` beside `sort`. Add CONTEXT.md terms.
- [ ] Run `pnpm run test:all`, `pnpm run build`, commit `feat: group the Activities list by week or month`.

### Task 3: Verify in the app

- [ ] Dev server on real data; Playwright screenshots: light and dark, phone width,
  each grouping, with a search, with a distance sort, with a preview open.
- [ ] Push, open the PR.
