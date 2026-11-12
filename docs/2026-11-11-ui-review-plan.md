# UI review: findings and fix plan

Date: 2026-11-11. Reviewed on real data (534 activities) in both themes at 1440×900,
1024×768 and 390×844: map, activity detail, replay, city route, empty state, analytics.

The work is split in two:

- **PR 1 (this plan):** items 1–9, 12, 13. Each is a few lines; no refactor.
- **PR 2 (later cleanup):** items 15, 16. Mechanical token tidy-up, no visual change.
- **Not scheduled:** items 10, 11, 14. Small; pick up in PR 1 if time allows.

Item numbers match the review as given in chat, so gaps in a list are deliberate.

## Findings

### Bugs

| # | Finding | Where |
|---|---------|-------|
| 1 | Phone: the bottom sheet and the replay bar cover the Mapbox logo and attribution. Mapbox's terms require both to stay visible. | `MapView.tsx` (no control offset), `index.css` |
| 2 | Phone: in "Climbing by month" the month total ("13.1k m") is drawn over late-month peaks. The value column is 46px, too narrow. | `ui/Ridgeline.tsx:68` (`GAIN_W`) |
| 3 | Light theme, map page: panels are 18–40% white, so terrain and routes show through behind 10–11px muted text (chart ticks, counts, hints). Dark is fine. | `index.css:161` |
| 4 | Light theme, map page: the header fade is too weak, so place names show behind the "ACTIVITY ATLAS" wordmark. Worst on a phone. | `index.css:131` (`--header-fade`) |

### Inconsistencies

| # | Finding | Where |
|---|---------|-------|
| 5 | Activity panel: the cards (86.8 km, 4h 25m, 19.6 km/h) and the "Whole activity" chips below (86.77 km, 5:24:07 "time", 18.1 km/h avg) disagree. The chip time is elapsed but labelled "time"; the chip speed is a mean of samples. Five chips in three columns also leave a half-empty row. | `profile.ts:241` (`summaryReadout`) |
| 6 | Raw type names are shown: "WeightTraining" in the filter list, the panel subtitle and the map tooltip. | `ui/FilterSection.tsx`, `App.tsx` (subtitle), `MapView.tsx:562` |
| 7 | Stat units are styled two ways: "6,137 km" has a small muted unit, "9 days" and "774h 40m" put the unit in full-size mono. | `analytics.ts:61`, `stats.ts`, `ui/StatsSection.tsx` |
| 8 | The map tooltip's dot is the type colour in every colour mode: a blue dot on an orange route in Plain mode. | `MapView.tsx:554` |
| 9 | "Replay history" stays an enabled accent button while a replay is running. | `ui/SidePanel.tsx`, `App.tsx` |
| 10 | Calendar: the moving-time summary sits by the year pills, far from its grid; the steps summary sits beside its "Steps" heading. | `ui/ActivityCalendar.tsx:178–191` |
| 11 | Tooltip reads "Ride · Apr 12, 2026", panel reads "Ride on Apr 12, 2026". Date ranges use an en dash except the ridgeline's isolation subtitle (em dash). | `MapView.tsx:562`, `App.tsx`, `ui/AnalyticsView.tsx` |

### Alignment and spacing

| # | Finding | Where |
|---|---------|-------|
| 12 | Filter rows are inset 10px from the section labels, slider and pills, on both sides. The "On this page" links have the same offset. | `ui/FilterSection.tsx` (`rowStyle`), `ui/SidePanel.tsx` (`jumpLink`) |
| 13 | Dead gap under "Route color" in Plain and Type modes: the legend slot is a fixed 40px, the hint is one 16px line. | `ui/ColorSection.tsx` (`slot`) |
| 14 | Phone analytics: the "Analytics" title sits about 10px under the header and 20px left of the card content. | `index.css` (`.analytics` at ≤760px) |

### Token drift

| # | Finding | Where |
|---|---------|-------|
| 15 | The type scale is bypassed about 29 times (`FS.xs + 0.5` ×13, `FS.sm + 0.5` ×8, `FS.xs + 1` ×5, …), so 11.5, 12 and 13 are real steps missing from the scale. | `ui/theme.ts`, all of `ui/` |
| 16 | Duplicated style constants: `divider` (SidePanel, FilterSection), `statusText` ×3, `sectionLabelStyle` (a copy of `theme.sectionLabel` without the letter-spacing), and `replayBtn` / `showButton` (the same tinted accent button at 38px and 34px). | `ui/SidePanel.tsx`, `ui/FilterSection.tsx`, `ui/AnalyticsView.tsx`, `ui/CityComparisons.tsx`, `App.tsx` |

## PR 1: plan

Branch from `main`. One commit per step, in this order (bugs first, so the PR can be
cut short and still ship). Run `pnpm --filter app run test` and `pnpm run typecheck`
after each step; several steps touch code with unit tests.

### Step 1 — Keep the Mapbox logo and attribution above the sheet (item 1)

- `App.tsx`: on the map page in the phone layout, write the measured height to the
  root: `document.documentElement.style.setProperty("--map-bottom-inset", …)` from
  `bottomPanelH` (0 on desktop, where the replay bar is centred and clears both corners).
- `index.css`: `.mapboxgl-ctrl-bottom-left, .mapboxgl-ctrl-bottom-right { bottom: var(--map-bottom-inset, 0px); transition: bottom .2s; }`.
- Check: phone width, sheet collapsed, sheet expanded, replay bar. Logo and
  attribution visible in all three.

### Step 2 — Ridgeline value column on phones (item 2)

- `ui/Ridgeline.tsx`: `GAIN_W = compact ? 58 : 60`.
- Check at 390px that "13.1k m" clears the ridge and the plot is still wide enough to
  read (it loses 12px).

### Step 3 — Light-theme legibility on the map (items 3, 4)

- `index.css`, `:root[data-theme="light"][data-view="map"]`: raise `--panel-bg` to
  about `rgba(255,255,255,.74)` → `rgba(255,255,255,.62)` and `--stat-cell-bg` to
  about `.55`. Tune by eye; the glass should still read as glass.
- Same block: add a stronger `--header-fade` (about `rgba(238,240,244,.97)`), and make
  the header gradient hold its colour for the first ~45% before fading
  (`ui/Header.tsx`, the `linear-gradient`), so the wordmark's line is covered.
- Check: light theme with an activity selected (chart ticks over terrain), and phone
  width (wordmark over labels). Dark theme unchanged.

### Step 4 — One set of numbers in the activity panel (item 5)

- `profile.ts` `summaryReadout`: drop the `km` chip (the card has it) and the
  `km/h avg` / `/km avg` chip (the card has moving speed or pace). Rename `time` to
  `elapsed`. Left at rest: elapsed, m high, bpm avg, cadence avg — at most four.
- `readout` (under the cursor) stays as is: there the values are the point's own.
- The chips are documented as "same chips, same order" so hovering never reflows.
  With fewer chips at rest the row count can change (1 row → 2). Keep the height
  stable: give `readoutRow` in `ui/ActivityCharts.tsx` a `minHeight` of two rows (52px).
- Update `profile.test.ts` expectations.

### Step 5 — Display names for activity types (item 6)

- `format.ts`: add `typeLabel(type)` — split CamelCase and lower the rest
  ("WeightTraining" → "Weight training", "StairStepper" → "Stair stepper"); test it in
  `format.test.ts`.
- Use it in `ui/FilterSection.tsx` (row label), `App.tsx` (subtitle),
  `MapView.tsx:562` (tooltip), and the elevation-profile legend in
  `ui/ElevationProfiles.tsx`. Grep for other places that print `.type`.
- Display only: filter keys, colours and aria-pressed state keep the raw type.

### Step 6 — Consistent stat units (item 7)

- `analytics.ts:61`: `{ value: String(c.longestStreak), unit: c.longestStreak === 1 ? "day" : "days", … }`.
- Durations: let `StatCard.value` stay a string, and in `ui/StatsSection.tsx` render
  the `h` / `m` letters of a duration in the unit style. Smallest way: add an optional
  `parts?: { value: string; unit: string }[]` to `StatCard`, filled by a
  `durationParts()` helper in `format.ts`, used by the two "Moving time" cards in
  `stats.ts`. `StatGrid` renders `parts` when present, else `value` + `unit`.
- Update `stats.test.ts` / `analytics.test.ts`.

### Step 7 — Tooltip dot follows the colour mode (item 8)

- `MapView.tsx:554`: `colorMode === "type" ? typeColor(…) : ACCENT`.
  `propsRef.current.colorMode` is already available there.

### Step 8 — Replay button state (item 9)

- `App.tsx`: pass `replaying` to `SidePanel`.
- `ui/SidePanel.tsx`: while replaying, disable the button, label it "Replaying…", and
  swap the hint for "Use the bar below to pause or exit."

### Step 9 — Align the filter rows (item 12)

- `ui/FilterSection.tsx` `rowStyle`: `margin: "0 -10px"`, `width: "calc(100% + 20px)"`.
  The hover background then bleeds 10px past the column and the checkbox and count
  line up with the labels and slider. The panel body has 18px padding, so nothing clips.
- `ui/SidePanel.tsx` `jumpLink`: the same negative margin.
- Check the focus ring isn't clipped by `.panel__body`'s `overflow-x: hidden`
  (outline 2px + offset 2px, 8px to spare).

### Step 10 — Route color hint slot (item 13)

- `ui/ColorSection.tsx` `slot`: keep the fixed height (it stops the Replay button
  moving between modes) but drop it to 30px — the gradient legend is 8 + 6 + ~13 = 27px.

### Before opening the PR

- `pnpm run test:all`, `pnpm run typecheck`, `pnpm --filter app run build`.
- Re-shoot the screens touched, both themes: desktop map, activity selected, replay,
  phone map (sheet closed and open), phone "Climbing by month".
- PR body: the item list above with before/after screenshots for 1, 2, 3, 5.

## PR 2: plan (items 15, 16)

No visual change intended; verify by screenshot diff against `main`.

1. `ui/theme.ts`: name the steps actually in use — e.g. `FS.xs2 = 11.5`, `FS.sm0 = 12`,
   `FS.sm2 = 13` (final names to be chosen) — mirror them in `index.css`, and replace
   every `FS.x ± n` with a named step.
2. Move `divider` and `statusText` to `ui/theme.ts`; delete the copies.
3. Delete `sectionLabelStyle` in `ui/SidePanel.tsx`; use `sectionLabel`. This is the one
   intended visual change: "On this page" gains the `.01em` letter-spacing the other
   labels have.
4. Add `tintButton` to `ui/theme.ts` (accent outline, tinted fill) and use it for
   "Replay history" and "Show on map"; settle on one height.

## Unscheduled (items 10, 11, 14)

- **10:** in `ui/ActivityCalendar.tsx`, move the moving-time summary from the year-pill
  row to the "Moving time" label row, as the steps summary already is.
- **11:** tooltip meta to "Ride on Apr 12, 2026 · 86.8 km"; the isolation subtitle in
  `ui/AnalyticsView.tsx` to an en dash.
- **14:** `.analytics` at ≤760px: padding `80px 12px 32px`; give the title and lede an
  8px left inset.
