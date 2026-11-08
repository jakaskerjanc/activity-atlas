# Active hours and daily steps on the Analytics page

Two new Analytics charts:

1. **Active hours:** a 24-hour clock of when you're out.
2. **Daily steps:** a calendar of your Garmin step totals, built to match the
   existing Activity calendar.

The owner picked both from real-data drafts on 2026-11-08 (see
[Decisions](#decided-by-the-owner)). Drafts that were tried and dropped are
listed under [Non-goals](#non-goals).

## Why

The owner wants the Analytics page to answer two new questions:

- **"When in the day am I out?"** This is a 24-hour clock like the
  listening-clock widgets in music apps. It shows time spent out, not just
  start times.
- **"Am I walking more?"** This is a calendar of daily steps, one square per
  day, shaded by steps. You read change from the shades, comparing the same
  weeks across years. There is no fitted line: the owner tried straight trend
  lines (least squares and outlier-resistant) and a moving average, and
  rejected all of them.

## Goals

- A **24-hour clock** of time spent out in each local hour, for the visible
  activities.
- A **steps calendar** that looks and behaves like the Activity calendar:
  - the same grid, cell size, year buttons, hover outline, tooltip position and
    phone layout;
  - its weeks line up column for column with the Activity calendar's.
- **Daily step totals become public.** This is the first and only wellness
  value published.

## Non-goals

- **Run pace over time.** It was drafted with a moving median and with
  straight trend lines, and was dropped. "Meters per heartbeat" and "best times
  so far" were suggested and not picked. Neither is in scope.
- **Steps trend lines.** No moving averages, regression lines or "steps per
  year" slope numbers.
- **"Activities started per hour" clock.** It was drafted as variant B and not
  picked.
- **Hourly steps.** Garmin only gives daily totals in this database.
- **Any other wellness value on the site:** sleep, resting heart rate, heart
  rate variability, stress, Body Battery, SpO2, weight, respiration, intraday
  series, or the step goal and walking distance stored next to the steps.

## Anti-goals: failure even if it works

- **Wellness data other than the daily step count reaches a display file.**
  The new file holds `date → steps` and nothing else, not even `raw`.
- **A partial day shows as a real low day.** The newest row in `daily_stats`
  is the fetch day, recorded partway through. On 2026-11-08 it read 23 steps
  for Nov 7.
- **A day without step data is drawn as a day with 0 steps,** or as "under
  10k".
- **The clock counts an activity only in its start hour,** or drops
  activities without saying so.
- **The clock uses UTC hours.** It must use the local wall-clock time of the
  activity.
- **A new runtime dependency for charts.**

## Constraints

These are inherited from `docs/2026-11-04-display-files-design.md` and still
hold:

- static files only;
- `build:tracks` reads the database read-only;
- absent means unknown, never `0`;
- the folder is emptied before each write;
- React 19 with inline styles, and no chart library;
- dark and light themes, each with its own validated colors.

## Verified facts (2026-11-08, database synced from R2)

**Activities.** 532 are visible. Every one has `start_local` and
`elapsed_time`; one has no `moving_time`. The longest `elapsed_time` is
17.5 h, so an activity can cross midnight.

**Clock shape** with the default type selection (Run, Hike, Walk, Ride), over
all dates (447 activities):
- Time out is close to flat from 07:00 to 20:00, peaking at about 74 h in the
  18:00 hour.
- Almost nothing happens between 22:00 and 05:00.
- Starts peak between 17:00 and 19:00. Long hikes fill the middle of the day.

**Steps.** `daily_stats.steps` covers 568 days, consecutive, from 2025-04-19 to
2026-11-07. The last row is partial.
- The first row, 2025-04-19, reads 4,825. It is probably the day the watch was
  set up, and is kept as is.
- The step goal (`raw.steps[0].stepGoal`) is 10,000 on every day except
  2025-04-20 and 2025-04-21.
- The distribution, excluding the partial day: 9 days under 10k, 264 at
  10–12k, 148 at 12–16k, 93 at 16–22k, 53 at 22k or more. The maximum is
  66,170.
- **The demo database has no `daily_stats` rows.**

## Design

### 1. Daily steps on the site

**Build (`scripts/build-tracks.ts`).** Write `app/public/data/steps.json`:

```ts
/** Root of steps.json: Garmin's daily step totals, the only wellness value published. */
export interface StepsFile {
  v: 1;
  /** First local date covered, YYYY-MM-DD. */
  start: string;
  /** Steps per local date from `start`, one entry per day; null = no total that day. */
  steps: (number | null)[];
}
```

- Read only `date` and `steps` from `daily_stats`. Never select `raw` or any
  other column.
- Leave out the newest date in `daily_stats`. That is the day the fetch ran,
  so its total is still growing.
- A missing date inside the span, or a `NULL` total, is `null`. It is never
  `0`.
- With no step rows (the demo, a fork without Garmin, a database without
  `daily_stats`), write `{ "v": 1, "steps": [] }`. *(Changed while building:
  the first draft skipped the file and relied on a 404, but Vite's dev server
  answers a missing file with `index.html`, so an always-present file is
  simpler. An empty file, a failed load and a missing file all hide the steps
  grid.)*
- A total of `0` is treated like a missing one (`null`): Garmin writes 0 for a
  day the watch recorded nothing.
- **Dates are local calendar dates** (Garmin's own). They are placed on the
  grid as if they were UTC days, which matches the Activity calendar's UTC
  days for all practical purposes in Slovenia.
- Keep the wire type in `scripts/types.ts` and `app/src/types.ts` in sync, as
  the existing files do.
- Fetch the file only on the Analytics page, as `profiles.json` is, using a
  hook shaped like `useRouteProfiles`.

**Wording that changes because steps are now public:**
- `README.md`: "Wellness data is never published" becomes "Wellness data is
  never published, except daily step totals".
- `docs/data-pipeline.md`: the same change to the "Display files" table and
  its text.
- `docs/2026-11-04-display-files-design.md`: add a dated note at "Wellness on
  the site" pointing to this document. Do not rewrite history.
- `CONTEXT.md`: add the glossary terms below.
- The MCP server's guide (`ingest/mcp_server/guide.md`) does not change.

### 2. Steps calendar

**Placement and filters.**
- It goes inside the Activity calendar card, below the moving-time grid, under
  its own small label "Steps". The two grids share one set of year buttons, so
  picking a year shows that year in both, column for column.
- It follows the **date range only**, cutting cells exactly as the Activity
  calendar does. The type selection does not apply to steps.

**Days without data.**
- Without a `steps.json` (the demo, a fork without Garmin), the steps grid and
  its label are not shown at all. The card is the Activity calendar as it is
  today.
- With the file, a picked year that has no step data shows a one-line note
  instead of a grid: "No step data for 2024".
- Days in the range without step data (before 2025-04-19, the left-out newest
  day, `null` days) are drawn the way the Activity calendar draws days outside
  the range: a faint outline, no fill.

**Shades.** These are fixed step ranges, using the existing `--heat-*` tokens
so the two grids read as one card:

| Level | Steps | Fill |
|---|---|---|
| 0 | under 10,000 | `--heat-0` with a 1.5 px `--accent` inset outline |
| 1 | 10,000–11,999 | `--heat-1` |
| 2 | 12,000–15,999 | `--heat-2` |
| 3 | 16,000–21,999 | `--heat-3` |
| 4 | 22,000 or more | `--heat-4` |

- The legend reads "Under 10k · 10–12k · 12–16k · 16–22k · 22k+".
- The outlined "under 10k" swatch is what makes it different from the
  moving-time legend.
- The 10k threshold is fixed. The stored goal is 10k on 566 of 568 days.

**Year summary.** This goes next to the year buttons, where the Activity
calendar shows moving time and active days. It reads "average 14.8k a day ·
308 of 310 days at 10k or more", computed over the days in range that have
step data.

**Hover.** Use the Activity calendar's hit-testing and tooltip. The tooltip
shows the steps and the date ("66,170 steps", "Sat, Apr 18, 2026"). A day
without a total has no cell, so nothing to hover.

**Phone.** Use the same `MonthGrids` layout as the Activity calendar, with the
steps month grids below the moving-time ones.

**Code.**
- Generalise `ActivityCalendar` rather than copying it. Separate the grid
  geometry and interaction from what a day holds and how it is shaded, so both
  grids share the year state, scrolling and tooltip mechanics.
- Put the step bucketing and the year summary in a pure module (next to
  `analytics.ts`) with tests, as `activityCalendar` and `calendarLevel` have
  now.

### 3. Active hours clock

**Data.**
- The visible activities, so it follows both the type selection and the date
  range.
- Each activity starts at `start_local`, the wall clock at its start, and runs
  for `elapsed_time`. If that is missing, use `moving_time`. If both are
  missing, skip the activity and say so in the card's footnote ("1 activity
  without a duration isn't counted"), per the honest-numbers rule.
- Spread the time over every local hour it covers. Wrap past midnight, so a
  17.5 h activity adds to hours on the next day's clock positions.
- Daylight-saving shifts inside an activity are ignored: start plus elapsed is
  treated as wall-clock time.

**Drawing.**
- 24 ring sectors, midnight at the top, running clockwise.
- Each sector grows outward from an inner circle. Its length is linear in the
  hours spent, scaled to the busiest hour.
- Every hour has a faint full-length background track, as in the draft.
- Fill is `--accent`. It is one series, so it gets no legend box; the title
  names it.
- The center is a small dial with ticks for every hour and labels 0, 6, 12 and
  18.
- Hovering a sector shows the hour range, the hours spent, and how many
  activities touched that hour ("18:00–19:00 · 73.7 h · N activities"). The
  hit target is the full-length track, not just the bar.

**Card.**
- Title "Active hours", subtitle "Time out in each hour of the day (local
  time)".
- A full-width (`span-2`) card, with the clock on the left and three short
  readouts on the right:
  - busiest hour;
  - share of time before 09:00;
  - share of time after 18:00.
- On a phone the readouts go under the clock.
- With no visible activities the page's existing empty state already covers
  it.

**Code.**
- A pure module (`activeHours.ts`) that returns 24 hour totals, per-hour
  activity counts and the skipped count, with tests for: midnight wrap,
  multi-hour spread, a missing duration, and an activity shorter than an hour
  inside one hour.
- A `ActiveHoursClock.tsx` component, in the existing chart components'
  style (see `Ridgeline.tsx`).

### 3a. Changed after the first build (owner, 2026-11-08)

The single clock read too big, and the owner wanted something other than the
readouts beside it. The card now holds **two smaller clocks side by side,
Weekdays (Mon–Fri) and Weekends**, split by the local date each activity
started on. Each clock is scaled to its own busiest hour, because they compare
when in the day you're out, not how much (the subtitle says so). Each clock has
a caption: its busiest hour and its total time. The three readouts are gone.
In the owner's data, weekdays peak 18:00–19:00 and weekends 10:00–11:00.

### 4. Page order

The new order is:

1. Totals
2. Consistency
3. How far is that?
4. Activity calendar (now with steps)
5. Active hours
6. Climbing by month
7. Elevation profiles

`ANALYTICS_SECTIONS` gets "Active hours". The calendar's entry stays
"Activity calendar".

## Decided by the owner

- The clock shows **time out in each hour** (draft A), not starts per hour.
- Daily step totals may be **published on the public site**. No other wellness
  value may be.
- Steps are shown as a **calendar of days**, with no trend lines of any kind.
  The steps chart should be **aligned with the existing Activity calendar**.
- Run pace is out for now.

## Calls made by the assistant (check these)

- **Steps share the Activity calendar's card and year buttons.** This is how I
  read "align it with the Activity calendar". The alternative is a separate
  card directly below with its own year buttons and the same geometry.
- **The weekday-average column from the draft is dropped,** because the
  Activity calendar has none.
- The bucket edges are 10k, 12k, 16k and 22k, using the `--heat-*` colors.
- The newest step day is always left out.
- No steps file is written for the demo or for forks without Garmin data, and
  the steps grid is then hidden entirely.
- The clock uses elapsed time (time out), not moving time.
- The clock is a full-width card with three readouts, placed after the
  calendar.

## Left to the builder

- How exactly to split `ActivityCalendar` into shared grid plus two day
  renderers.
- Exact readout wording and number formatting, following `format.ts`.
- The light-theme check of the accent outline on `--heat-0`, by eye. The
  `--heat-*` ramp itself is already validated for both themes.
- Tests in the style of the existing `*.test.ts` files, including a
  `build-tracks.test.ts` case that `steps.json` holds no field other than
  `v`, `start` and `steps`, and leaves out the newest day.
