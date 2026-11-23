# Activities page: route thumbnails and training-log grouping

Two small additions to the Activities page, agreed with the owner on
2026-11-23 (brainstorm). Choices the owner did not make are marked
**(my call)**.

## 1. Route thumbnails

**Why:** recognise routes at a glance in the list.

- A 36 px drawing of the route at the left of the activity name, in every row,
  phone layout included.
- Drawn in the activity's **type color**, north up, no basemap.
- Inline SVG from `trackSketch` (the preview's module), computed once per
  activity id and only for the rows the virtualizer draws.
- No route (weight training…) or routes still loading: the slot stays empty so
  names line up.
- Rejected: a still Mapbox image per row (hundreds of requests, too small to
  show a map).

## 2. Training-log grouping

**Why:** read the list like a training diary, with subtotals per week or month.

Agreed sketch:

```
 [ Search…            ]      Group: ( None | Week | Month )

 NOVEMBER 2026              12 activities · 98 km · 11 h 40 m · 2,310 m
 ───────────────────────────────────────────────────────────────────────
 21 Nov   ⌇  Šmarna gora loop      11.2 km    1:02:10    410 m    ›
 19 Nov   ◠  Evening ride          34.0 km    1:15:40    280 m    ›
 OCTOBER 2026               18 activities · 160 km · 17 h 05 m · 3,940 m
```

- A **Group** control: None (default), Week, Month.
- Week header: `WEEK OF 17 NOV · 4 activities · 31 km · 3 h 10 m · 820 m`.
  Weeks start on Monday.
- Weeks or months with no activities between two groups show one thin line,
  e.g. `— 2 weeks without activities —`, so rest periods are visible.
- Subtotals count only what is listed (the search narrows them).
- Group by the same calendar date the row shows (keep the page consistent with
  itself) **(my call)**.
- With a non-date sort (distance, climb…), groups stay in date order and rows
  sort inside each group: "longest run of each month" **(my call, shown to the
  owner)**. The group order follows the date direction (newest first unless
  the sort is oldest first) **(my call)**.
- The group choice is kept wherever the sort is kept today (the owner was told
  "like the sort") **(my call)**.
- Headers and gap lines are items in the virtualized list, keyboard row
  navigation skips them, previews still open under their row.
- Phone: headers wrap the totals under the title **(my call)**.
- Add the terms to `CONTEXT.md`.

## Approaches

One sensible way for each: they extend the existing list (virtualizer items,
the existing grid) rather than adding a new view. A separate "log" page was not
considered worth it.
