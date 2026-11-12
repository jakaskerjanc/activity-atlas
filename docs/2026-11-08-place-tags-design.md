# Design: places from your own tracks, same-route groups and a Places filter

Date: 2026-11-08, rewritten 2026-11-09
Status: draft for the owner's review
Scope: section 1 of issue #35 (GPS-derived grouping), shown on the site and in
the MCP server. Sections 2 (offline gazetteer) and 3 (text and semantic
search) are out. [2026-11-09-activity-embeddings-research.md](2026-11-09-activity-embeddings-research.md)
covers why embeddings aren't needed for this.

## Intent

The owner wants to pick a place in the app and see every activity that went
there: "all hikes to Slavnik", "rides over Vršič". For one activity, they want
to see the other times they did the same route. Activity names can't answer
either question: 358 of 531 activities have default names like "Morning
Hike". The answer has to come from the tracks.

## What changed from the 2026-11-08 draft

- **Places come from the owner's own activities, not from OpenStreetMap's
  list of every peak.** An activity's highest point is where it went.
  Activities whose highest points are close together share a place. This
  names places the way the owner does: Nanos, Velika planina and Ratitovec,
  where matching against OSM gives Pleša, Gradišče and Altemaver.
- **OSM is used only for names.** Only named points are downloaded: peaks,
  passes, parks, ponds and neighbourhoods. There are no outlines, no
  filtering by those features, and no reach rules.
- **New: same-route groups,** for "the other times on this route", with
  automatic names such as "Novo Brdo loop via Rožnik".
- **No tag cache or rules versions.** Everything is recomputed on each
  database write, which takes seconds.
- **No hiding rule for places near home.** Instead, no coordinates of places
  reach the site, and flat activities get no place (see Anti-goals).

## Goals

- Every activity with GPS, altitude and a real climb gets a **place**, shared
  across activity types.
- Activities that follow the same track form a **same-route group**, with a
  name chosen automatically.
- The app has a **Places** section in the filter panel (mockup A). Picking a
  place adds it to the shared activity filter, so Hike + Slavnik reads as
  "Hikes to Slavnik".
- The selected activity shows its place and the other times on the same
  route.
- The MCP server can filter by place and list an activity's same-route
  group.
- No new Python dependencies, and no network calls in CI.
- Deterministic: a run with no new data leaves the database byte for byte
  the same, so nothing is uploaded.

## Non-goals

- Lakes, huts, towns and protected areas as filters (owner: "Summit search
  seems like the only obvious one"). Parks, ponds and neighbourhoods are used
  only to name routes.
- Season, time of day and elevation band. They come from existing columns.
- Peaks as clickable map markers (mockup B).
- **Segments:** timing shared stretches, like one climb, across runs that
  otherwise differ. This is what would answer "am I getting faster?" for
  runs, which rarely repeat a whole route. It needs its own design.
- "Similar but not the same" activities (feature vectors) and embeddings.
- More than one place per activity. A traverse over three summits counts
  only for the highest.
- A page that lists route groups.

## Anti-goals

- **Marking home.** No coordinates of a place leave the database:
  `places.json` carries id, name, height and kind only. The routes the site
  already draws are the only location data published, as today.
- **Network calls in the daily CI job.**
- **Groups that change on their own.** New activities join existing groups.
  Existing groups change only when their own activities do.

## Measured on the owner's data (2026-11-09)

All figures come from read-only scripts on `data/activities.sqlite`.

| Type | With GPS | Get a place (top ≥ 50 m above start) | In a same-route group of 2+ |
|---|---|---|---|
| Hike | 138 | 136 | 26, in 7 groups (largest 10) |
| Walk | 82 | 60 | 13, in 4 groups |
| Ride | 64 | 35 | 0 |
| Run | 153 | 16 | 25, in 8 groups (largest 5) |

- **Runs are flat.** They average 45 m of climbing, so a run's highest point
  is usually just where the road peaked. Without the 50 m rule, flat runs and
  rides formed "places" next to the usual start. Runs get same-route groups
  and almost no places.
- **Places across rides, hikes and walks:** 23 with 2 or more activities,
  and 84 with one. Slavnik has 29 hikes.
- **Same-route groups mostly sit inside one place:** all 7 hike groups do,
  and all 4 walk groups. This was measured before the 50 m rule was added.
- **Time:** places took 1.8 s in plain Python for all activities, including
  decoding the streams. Same-route matching added about 16 s, using naive
  Python loops over 64-point tracks.

## Places

### An activity's highest point

- The track is the full-resolution stream (lat, lon, altitude). Altitude is
  smoothed with a 15-sample moving average, so a single spike can't become
  the top. The highest smoothed sample is the activity's **top**.
- An activity gets a place only if its top is at least **50 m above its
  start** (the smoothed altitude 15 samples in). Activities without an
  altitude stream (9 of 446 runs, hikes, walks and rides) get none.

### Grouping

- Activities are taken in order of start time, then id. Each one joins the
  first place whose **anchor** is within **500 m** of its top. Otherwise it
  starts a new place and becomes that place's anchor. The anchor is the top
  of the place's first activity.
- Comparing with the anchor, rather than with any member, stops places from
  chaining along a ridge.
- The place's id is its anchor activity's id, so a new activity never
  changes an existing place. Importing an *older* activity later can create a
  new anchor. Owner names that no longer match a place are then reported, not
  dropped silently.
- One place spans all activity types: rides and hikes up Slavnik are both
  "Slavnik".

### Naming

Measured on the 23 places with 2 or more activities: 8 are named from the
owner's own activity names, 13 from OSM, and 2 get nothing. Those 2 are
Ankogel in Austria, which wasn't downloaded, and a 727 m top with no OSM peak
within 400 m. Only Slovenia was loaded for this test.

The first rule that gives a name wins:

1. **The owner's name for the place**, set with the `activity` CLI (below).
2. **A word that repeats in the owner's activity names,** in at least two of
   the place's activities. Generic words are ignored, in English and
   Slovenian: morning, hike, ride, pohod, izlet, na, do and so on.
   Automatic names of the form "‹town› Walking/Hiking/Running/Cycling…"
   count as default names, like "Morning Hike". They name the town where
   the activity started, not where it went. When the word is the start of
   the nearby OSM name, the OSM spelling is used, so "Šmarna" becomes
   "Šmarna gora". Otherwise the name keeps the spelling of the activity
   names, so "Velika planina" stays as written.
3. **The nearest named OSM peak or pass within 400 m** of the place's
   highest top.
4. **"Top at 1,068 m"** as a last resort. The job lists these places so the
   owner can name them.

A place with one activity skips rule 2, because one name isn't a pattern.
Without that, names like "Test Shitbox" and "Čateža Železniške" turned up in
the test.

Known misses in the test:
- The large walks place came out as "Ljubljana", while OSM has Šišenski
  hrib. Four of its walks are called "Ljubljana Walking", and that was the
  only word that repeated. Across all activities, 38 have names like this:
  Ljubljana 24, Koper 3, Mallnitz 2, Hrpelje-Kozina 2, Medvode 2, and others.
  The default-name rule above fixes this; it was added after the test.
- Two different places are called Grmada (999 m and 676 m). The list shows
  heights, so they stay apart.

The height shown is the `ele` of the OSM peak or pass within 400 m of the
place's top, when there is one. Otherwise it's the place's highest smoothed
top, rounded to 10 m.

### Owner names and merges

- `pnpm run activity places` lists every place with id, name, where the name
  came from, height and count. Unnamed places come first.
- `pnpm run activity name-place <id> "Šmarna gora"` sets a name, and
  `pnpm run activity merge-place <id> <into-id>` merges one place into
  another (e.g. Šmarna gora's second top, Grmada 676 m).
- `pnpm run activity routes` and `pnpm run activity name-route <id> "Tivoli
  loop"` do the same for same-route groups. Overriding a route name is
  optional; routes are always named automatically.
- These are kept in the database and carried over by a rebuild, the way
  `activity_overrides` already is.

### OSM names, for naming only

- `pnpm run places:update SI AT IT NO …` runs on the owner's machine. For
  each country it fetches named features from Overpass, each as one point:
  - `natural=peak`, `natural=saddle` and `mountain_pass=yes`, with `ele`
  - `leisure=park` and `natural=water`, as their centre (`out center`)
  - `place=neighbourhood|quarter|suburb|hamlet|village` nodes

  Each response is stored in the archive byte for byte and parsed into a
  table of named points. A rebuild re-derives the table without network.
- None of these are filters or tags. They only name places and routes.
- Size, measured 2026-11-09 for Slovenia: 19,146 points (11,263 peaks,
  saddles and passes; 7,126 neighbourhood to village nodes; 252 parks; 505
  ponds and lakes). That's 871 KB as compact JSON with kind, name, position
  and height, and 279 KB gzipped. The ten or so countries should total a few
  MB, with Norway the largest (not measured).
- When a new place has no OSM peak within 10 km, its country is probably
  missing. The job prints "2 places have no OSM data nearby; run
  places:update", and doesn't fail.

## Same-route groups

- **Track:** the activity's polyline, resampled to 64 points evenly spaced
  by distance. The polyline is enough; no stream is needed.
- **Candidates:** the same activity type, distance within 15% of the longer, and the start
  of one within 1 km of the start or the end of the other.
- **Same route:** discrete Fréchet distance under **250 m**, in either
  direction. A reversed loop counts as the same route (owner's decision).
- **Grouping:** the same anchored, chronological method as places, so groups
  don't chain. The group id is the anchor activity's id.

### Naming routes

Route names are automatic. Owner names exist only as an optional override
(CLI below), and no route ever needs one. A name has two parts: a **base**
that says where the route goes, and, only when two routes share a base, a
**"via"** that says where they differ.

**Naming a point.** Several steps name a point on the track. Each uses the
nearest named OSM feature of the first kind that has one within its radius,
taken in this order:

| Kind | Radius |
|---|---|
| peak, saddle or pass | 150 m |
| park (`leisure=park`, its centre) | 250 m |
| pond or lake (`natural=water`, its centre) | 150 m |
| neighbourhood | 800 m |
| quarter or hamlet | 1 km |
| suburb | 1.5 km |
| village | 2 km |

**Base:**
- **A route with a place:** the place's name plus the shape, e.g. "Slavnik
  out-and-back" or "Nanos loop". It matches the Places list.
- **A flat loop or out-and-back:** the name of its **turnaround** (the track
  point farthest from the start) plus the shape, e.g. "Novo Brdo loop" or
  "Koseze loop". On a flat route the turnaround plays the part the summit
  plays on a hike.
- **Point-to-point:** "start → end", e.g. "Rožna dolina → Vrtača". When both
  ends get the same name, the route is named like a loop instead. A route
  that starts from home names its neighbourhood, which the owner accepted.
- **No OSM name in reach** (the demo data, or a country not downloaded):
  the distance and shape, e.g. "5.2 km loop".

**When routes of the same type share a base,** each gets the first of these
that works:
1. **"via" the point where this route is farthest from the others,**
   ignoring the first and last 500 m of the track: "Novo Brdo loop via
   Rožnik", "Novo Brdo loop via Ribnik". Routes leaving from the same place
   always look alike near it, so that stretch says nothing. The 500 m rule
   also stops names from naming the area around the usual start.
2. "via" a feature that only this route passes (within 75 m of it, and more
   than 150 m from the others).
3. The distance: "Park Angele Piskernik loop, 10.0 km".
4. The month and year of its first activity, e.g. "Park Angele Piskernik
   loop, since May 2024". This is for routes that differ only near the
   start. If that still collides, the full date, then a number: "(2)".

**Shape** uses the 2026-11-08 draft's rules:
- **point-to-point:** the end is more than 200 m from the start
- **out-and-back:** start and end within 200 m, and at least 70% of the
  second half lies within 50 m of the first half
- **loop:** start and end within 200 m otherwise

**Measured** on the 19 route groups (2026-11-09, Slovenia's OSM data): every
group gets an automatic name.
- **Runs:** Novo Brdo loop via Rožnik, Novo Brdo loop via Ribnik, Novo Brdo
  loop via Rožna dolina, Zgornja Šiška loop, Koseze loop, Rožna dolina →
  Vrtača, and two "Park Angele Piskernik loop, 10.0 km".
- **Walks:** Rožnik loop, Šišenski hrib loop via Tivolski vrh, via Spodnja
  Šiška, via Park Tivoli.
- **Hikes:** Slavnik loop, Slavnik out-and-back via Skadanščina, via
  Podgorje, Triglav loop, Šmarna gora loop. Two loops near Nanos got the
  OSM name "Veliko Ubeljsko loop" and were told apart by distance. The test
  didn't apply place names; in the design they take their place's name.

The two 10 km park loops differ only in their first and last 500 m. They are
the one pair that needs rule 4, which wasn't in the tested script. Without
the 500 m rule, all 19 names were distinct, but four of them said "via
Vrtača", the area around the start.

## When it runs and where it's stored

- In the write job, after the records are applied and before the database
  is uploaded. That covers the daily Garmin fetch, imports, rebuild and the
  `activity` merge and split commands. CI needs no new step.
- Everything is recomputed, but **only rows that differ are written**.
  `writer.run` uploads only when the file's hash changes, so a run with no
  new data uploads nothing.
- New tables for the places, the per-activity place and route ids, the OSM
  named points, and the owner's names. That means a schema bump to v5, and
  `open_for_write` rebuilds older databases from the archive automatically.

## The site's data

- `build-tracks.ts` writes `places.json`, version 1, as
  `{v: 1, places: [{id, name, ele, kind}], routes: [{id, name}]}`.
  - `places` holds every place with at least one visible activity. `kind`
    is peak, pass or top.
  - `routes` holds every route group with at least two visible activities.
  - There are no coordinates in it.
  - Route names live in this file because `routes.json` already holds the
    route polylines.
- Each record in `activities.json` gains `place` and `route` ids. Both are
  opaque activity ids, and either can be missing.

## UI

Unless a decision is attributed to the owner, everything here is Claude's
call, open to change in review.

### Places in the filter panel

The **Places** section goes in the filter panel (`FilterSection`), between
Activity types and Date range, with the same section heading, divider and row
style as the type list. On the Analytics page it appears too, since the
filter panel is shared.

```
PLACES
[ Search places          ]
▲ Šišenski hrib      429 m   38
▲ Slavnik          1,028 m   29
▲ Šmarna gora        669 m   13
▲ Rožnik             393 m   10
▲ Nanos            1,262 m    9
▲ Krim             1,107 m    5
▲ Peštota            588 m    5
▲ Velika planina   1,667 m    4
+ 99 more
```

The names and counts are from the 2026-11-09 test (rides, hikes and walks,
all types on). The 99 others are mostly places visited once; the full list
includes passes such as ⋈ Preval pod Toškim čelom.

- **Rows:**
  - a kind icon: ▲ for a peak, a saddle icon for a pass, none for "Top at …"
  - the name, wrapping onto a second line if it's long
  - the height
  - the count, right-aligned in the type list's count style
- **Order:** by count, then by name. The first 8 rows show, then "+ N more"
  opens the full list in place, and "Show fewer" closes it.
- **Search** matches anywhere in the name and ignores case and accents, so
  "smarna" finds Šmarna gora and "vrsic" finds Vršič. While a search is
  typed, every match shows, not just the first 8.
- **Counts follow the type selection and date range.** With only Hike on,
  Slavnik's count is hikes to Slavnik. This differs from type counts, which
  ignore whether their type is on. In turn, type counts follow the selected
  place, so with Slavnik picked the type list counts activities to Slavnik.
- **A place whose count drops to 0 leaves the list.** The selected place is
  the exception: it stays, showing 0, so it's clear why the map is empty.
- **Picking:** one place at a time. The picked row is highlighted like an
  on type, and clicking it again clears it. Picking a place changes neither
  the types nor the dates.
- **No places at all:** the section is hidden. The demo data has places,
  named without OSM, so a fork shows the section.
- **Phone:** the same section in the filter overlay; the expanded list
  scrolls with the panel.
- **Accessibility:**
  - the search box has a label
  - rows are buttons with `aria-pressed`, like the type rows
  - "+ N more" is a button with `aria-expanded`

### The shared filter and the map

- The place is a third part of the activity filter (`activityFilter.ts`),
  next to the type selection and date range. The visible activities, the map's
  filter expression, the stats panel, Analytics and replay all apply it. The
  rule stays in one place, as `activityFilter.ts` intends.
- **Camera:** picking a place flies the map to the densest cluster of the
  routes that remain, with the same easing replay uses and a closest zoom of
  12. Clearing a place doesn't move the camera.
- **No place markers** on the map. Markers are a non-goal (mockup B), and
  they would publish coordinates (anti-goal).
- **Stats panel title,** which reads "All activities" today:
  - exactly one type on: "Hikes to Slavnik", or "Rides over Vršič" for a
    pass
  - more than one type on: "To Slavnik", or "Over Vršič"
  - the subtitle stays the date range
- Clicking a month in the ridgeline keeps the place. The place is cleared
  only by clicking it again, or by a click on another place.

### The selected activity

The detail panel (`InfoPanel`) gains up to two rows under the stat cards,
above the charts. They do different jobs, and they look different:

```
Morning Hike
Hike on 21 Aug 2025
[ stat cards ]
▲ To Slavnik · 29 times                         →
↻ Slavnik out-and-back via Skadanščina · 10×    ▸
[ charts ]
```

- **The place row takes you into the filter.** "To Slavnik · 29 times" has
  a → and works like picking Slavnik in the Places list. It sets the place
  filter, keeps this activity selected and flies the map there.
  - The count covers all of the place's visible activities, whatever the
    current filter, because it's a fact about this activity.
  - Passes read "Over Vršič · 7 times".
- **The route row opens a comparison in place.** It shows the route's name,
  the number of times, and a ▸. Clicking it expands a short table of the
  group's activities, newest first:

  ```
  ▾ Slavnik out-and-back via Skadanščina · 10×
    21 Aug 2025   2:05 h   ← this one
     3 May 2025   1:58 h   fastest
    14 Oct 2024   2:12 h
    …
  ```

  - **Columns:** date and moving time. Runs add pace.
  - This activity is highlighted, and the fastest moving time gets a small
    "fastest" label.
  - **Clicking a row** selects that activity. The table stays open, so you
    can step through the group.
  - **While the table is open,** the group's routes are drawn in the accent
    and the other routes are dimmed, like the existing hover highlight.
    Closing it restores the map.
  - **Activities outside the current filter** are still listed, greyed out.
    Clicking one widens the date range and switches its type on, just enough
    to show it.
- **Which rows show:**
  - a hike on a repeated route: both rows
  - a one-off hike: the place row only
  - a flat run on a repeated route: the route row only
  - a flat one-off: neither
- **Phone:** both rows sit in the bottom sheet under the stat cards, so
  they show once the sheet is pulled up.
- **Accessibility:** the place row is a button. The route row is a button
  with `aria-expanded`, and its table is a list of buttons.

### Words

`CONTEXT.md` gains:
- **Place:** where activities went, found from their highest points and
  named automatically.
- **Place selection:** the place part of the activity filter.
- **Same route:** activities that followed the same track, either
  direction.
- **Turnaround:** a flat route's farthest point from its start, which names
  it.

## MCP server

- `list_activities` and `summarize` gain a `place` filter (id or exact
  name, ignoring case and accents), with the usual `counted` rules.
- `places` lists places with id, name, height, name source and count.
- `same_route(activity_id)` returns the route's name and the other
  activities in its group, with date, distance, moving time and pace.
- `guide.md` documents the tables and rules.

## Left to the builder

- Table and column names.
- The generic-word lists. Slovenian case endings ("na Šmarno goro") split
  word counts, which is one reason owner names exist.
- Whether to speed up the Fréchet loop. It isn't needed at this size.
- Exact panel styling, within the existing design.

## Open questions for the owner

- **Hike and Walk on the same track:** one same-route group, or separate by
  type? v1 keeps them separate.
- **"Top at 1,068 m" places:** shown in the list until named (v1), or hidden
  until named?
- **A Routes list in the filter panel,** next to Places, so that picking
  "Novo Brdo loop via Rožnik" filters the map and stats? With names this
  becomes possible. v1 shows routes only on the selected activity.
- **Should one-off routes be named too?** Only same-route groups of 2 or
  more get a route name (19 groups, 64 activities). The same rules could name
  every GPS activity, which would replace "Morning Run" with "Koseze loop".
  Not tested.

## Done when

- [x] A rebuild reproduces places, same-route groups and names without
      network.
- [x] Tests on a fixture:
  - Slavnik's hikes share one place.
  - A flat run gets no place.
  - A reversed loop is the same route.
  - The naming order holds.
  - "Šmarna" becomes "Šmarna gora".
  - A flat loop is named after its turnaround.
  - Routes that share a base get distinct names, and a "via" is never
    within 500 m of the start or end.
  - No two routes of the same type end up with the same name.
  - Merges and renames survive a rebuild.
- [x] A write job with no new data leaves the database unchanged and
      uploads nothing.
- [x] `places.json` has no coordinates.
- [x] The Places section filters the map, stats and Analytics together, and
      the selected activity shows its place and same route.
- [x] Sizes of the new tables and `places.json` are measured and written
      down.

  Measured 2026-11-11 on the owner's data, with SI and AT loaded:

  - `places.json`: 8,296 bytes, 2,476 gzipped (108 places, 21 routes). The
    demo's is 1,567 bytes, 385 gzipped.
  - Raw OSM snapshots in the archive (`osm/<CC>/…`), as Overpass returned
    them: SI 3,909,501 bytes, AT 10,002,472 bytes. The 871 KB for Slovenia
    above counts the parsed points only.
  - Points kept: SI 19,144, AT 49,203. 31 features near the border come
    back for both countries and are counted once, so SI + AT = 68,347 rows.
  - Database: 44,732,416 bytes before, 52,359,168 after the v5 tables were
    added by hand and the OSM points loaded from a scratch archive (the same
    effect on the data as `places:update`), and 52,387,840 after the first
    refresh.
  - Rows: `osm_points` 68,347, `places` 108, `route_groups` 21,
    `activity_groups` 280.
