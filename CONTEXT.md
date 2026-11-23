# Activity Atlas

A personal atlas of every recorded activity (Strava + Garmin): routes drawn over a base map with filtering, coloring, and a chronological replay, plus an analytics page and daily wellness data.

## Language

### Activities

**Activity**:
One recorded outing (a run, ride, hike…) with its route, start time, and stats.
_Avoid_: track (for the record), workout

**Activity type**:
The sport an activity is filed under (e.g. Run, Ride, Hike).
_Avoid_: sport, category

### Filtering

**Activity filter**:
The user's current choice of which activities are shown: a type selection, a date range and an optional place selection.
_Avoid_: activity window, view, selection

**Type selection**:
The set of activity types currently switched on. Empty means no activities are shown; there is no separate "all" state. On load it holds Run, Hike, Walk and Ride (those the data has, or every type when it has none of them). It holds types, never type rows: switching a row switches every type in it.
_Avoid_: enabled types, type filter

**Type row**:
One toggle in the type selection list. A type with at least 10 activities (over all dates), one of Run, Hike, Walk and Ride, or Workout gets its own row; every rarer type is listed under the Workout row, which also counts them. Worked out from the data on every load, so a type moves out to its own row once it reaches 10.
_Avoid_: category, group, other

**Date range**:
An inclusive span of whole calendar months (UTC) that an activity's start must fall within. Clicking a month in the ridgeline narrows it to that month (isolating the month); clicking the month again restores the range it had before.
_Avoid_: date window, time window

**Place**:
Where activities went, found from their highest points and named automatically.
_Avoid_: summit, destination, tag

**Place selection**:
The place part of the activity filter; one at a time.
_Avoid_: place filter

**Visible activities**:
The activities that pass the activity filter.
_Avoid_: filtered features, shown set

**Type color**:
The one fixed color an activity type has everywhere it is colored: the map's Type color mode, the swatches in the type selection list (which double as the map's legend in that mode), and the analytics charts. A type listed under the Workout row wears Workout's grey, so the list stays a true legend, and gets its own color once it has its own row. It never depends on which types are switched on, and no type uses the accent orange (that means the app and the selected activity).

**Type count**:
How many activities of a type fall inside the date range and the selected place, regardless of whether that type is switched on.

### Interaction

**Selected activity**:
The single activity the user clicked to inspect. Unrelated to the type selection.
_Avoid_: active activity

**Activity detail**:
The downsampled samples of one activity (distance, position, altitude, heart rate, speed, cadence), loaded only when it is selected.
_Avoid_: streams (the full-resolution database data), track

**Cursor**:
The one point along the selected activity that the charts and the map marker share; set by hovering either.
_Avoid_: hover (that is route-level, see hoverId), playhead

**Same route**:
Activities that followed the same track, in either direction.
_Avoid_: matched activities, segment

**Turnaround**:
A flat route's farthest point from its start, which names it.

**Color mode**:
How the map colors routes: Plain (the accent), Type (type color), Recency, Grade, Speed, or Heat.

**Heat** (color mode):
Every route drawn thin and see-through in the accent, so roads you've been along many times glow brighter where the lines overlap (rare … frequent).
_Avoid_: heatmap (that suggests blurred density blobs)

**Deep link**:
A URL that reproduces what is on screen: the activity filter, the selected activity and its open same-route group, the color mode and the map camera in the query string (only values that differ from the defaults), the page in the hash. Changing page adds a browser history entry; every other change rewrites the current one.
_Avoid_: permalink, share link

### Pages

**Map** / **Analytics** / **Activities**:
The three pages. All show the visible activities, under one shared activity filter.
_Avoid_: tab, screen, dashboard

**Activity search**:
The Activities page's search box: it narrows the visible activities to those whose name, type, place, same-route name or start date contain every word typed (case and accents ignored). It is not part of the activity filter, so the map and analytics don't follow it; matches the filter hides are offered as a way to widen it.
_Avoid_: search filter

**Activity preview**:
The quick look under a row of the Activities page, opened by clicking it: the route on a still map image, the activity's stat cards and elevation chart (the map panel's own), and "Show on map".
_Avoid_: details, expanded row

**Route thumbnail**:
The Activities page's 36 px drawing of a row's route beside its name, in the type color, north up, without a basemap. A row without a route (or while the routes load) keeps the empty slot.
_Avoid_: map preview (that is the activity preview's still map image)

**Grouping**:
The Activities page's Group choice: None, Week or Month. Grouped, the listed activities are split by the calendar week (from Monday) or month of the date their row shows (UTC), each under a group header; the sort applies inside each group, and the groups go newest first unless the sort is oldest first. Kept like the sort: for the visit, not in the deep link.
_Avoid_: training log (that is what it reads like, not its name), sections

**Group header**:
A grouped list's line over each week or month: its name ("Week of Nov 17, 2026", "November 2026") and the subtotals of the activities listed under it (count, distance, moving time, climb), so a search narrows them too.
_Avoid_: group title, summary row

**Gap line**:
The one thin line between two groups that stand apart, saying how many weeks or months between them have no activities (no matches, while searching).
_Avoid_: rest period, empty group

**Active day**:
A calendar day (UTC, like the date range) with at least one visible activity.

**Streak**:
A run of consecutive active days.

**Route profile**:
An activity's elevation every 100 m of distance, measured from its start (profiles.json), so a loop starts and ends near 0 wherever it was.
_Avoid_: elevation profile (that is the selected activity's chart)

**Grade**:
How steep a route is at a point: rise over run in %, read from its route profile. The map's Grade color mode colors each route along its length by grade, on a fixed diverging scale: neutral grey within ±1%, climbs through amber and orange to deep red, descents through blue to deep blue, saturating at ±15%.
_Avoid_: gradient (that is the color ramp), slope

**Distance comparison**:
The Analytics card ("How far is that?") that turns the visible activities' distance into one trip from Ljubljana: for rides, and for runs, walks and hikes together (on foot), a city about that far by bike or on foot, and how much of the way the total covers.
_Avoid_: city match (that is the picking step)

**City route**:
A distance comparison's route from Ljubljana to its city, drawn dashed on the map after "Show on map". It follows the activity filter, and gives way to a selected activity or replay.

**Elevation profiles** (chart):
The Analytics chart that draws every visible activity's route profile as a see-through line against distance in km, in its activity type's color; repeated climbs darken where the lines stack up.
_Avoid_: heatmap

**Year against year**:
The Analytics chart of the visible activities' running total (distance, climbing or moving time) through the calendar year, one line per year from January to December (UTC days). The newest year is the accent line and stops at today; a line in the date range's first year starts where the range does. The sentence above it reads the newest year against the year before on the same date, and is left out when the two lines don't start on the same day.
_Avoid_: cumulative chart, progress chart

**Steps calendar**:
The second grid in the Activity calendar card: the same year's days on the same grid, shaded by Garmin's daily step total (under 10k ringed in the accent, then 10–12k, 12–16k, 16–22k, 22k+). It follows the date range only; the type selection doesn't apply to steps. Daily step totals are the only wellness data the site publishes.
_Avoid_: steps heatmap

**Active hours**:
The Analytics clock of time out in each local hour of the day: each visible activity counts in every hour from its local start through its elapsed time, wrapping past midnight.
_Avoid_: activity clock, listening clock

**Heart-rate zones** (card):
The Analytics card of how the visible activities' time with heart rate splits across six bands (below zone 1, then zones 1 to 5): a strip and a row per band with hours and share, then one stacked bar per month from the first month with zone time, in hours or as each month's share. Activities without zones are left out.
_Avoid_: intensity, training load

**Reference limits**:
The one set of heart-rate zone limits every activity's zones are measured against: those of the newest activity whose watch reported its zones. The zones are recomputed from each heart-rate stream at build time, so time in a zone compares across the whole history; the watch's own per-activity zones are not shown.
_Avoid_: zone settings, thresholds

**Running fitness** (card):
The Analytics card of how much running the heart buys, an estimate: each visible run's efficiency (grade-adjusted metres per heartbeat) shown as flat-ground pace at 150 bpm, corrected for climbing, and the mean of the trailing 91 days of those paces as a line, faster up (evaluated weekly back from the newest run, from five runs, broken when the newest run in the window is over 28 days old). The chart shows only the line: its breaks are bridged by a faint dotted connector (display only, never a value), and hovering inside one says why there is no value (no runs, or too few for a 3-month average). The card's lead line gives the line's latest value ("now", or "as of" its date when it is older than a week), the change since a year earlier, and its fastest value, the **best**. Efficiency is computed at build time from the streams: the first 10 minutes are left out (warm-up), and so are pauses and anything slower than 1.5 m/s grade-adjusted; each metre is weighted by Minetti's energy cost of running at its grade (measured over 50 m, within ±30%). A run with under 10 minutes left, or a run without altitude that reports climbing (an inclined treadmill), has no value. The **climb correction** takes off what the grade adjustment leaves in (hillier runs still read slower): pace less a slope × the run's elevation gain per km, the slope fitted in the app on every load by least squares over all runs with a value and a climb (not just the visible ones), with a level per two-month time bin so a change in fitness isn't read as hills; 0 when fewer than 20 runs share a bin, never below 0. That change reads the line now against the line a year before ("27 s/km faster than a year ago"), and is left out when there is no line then. Run only.
_Avoid_: VO2max, fitness score, training load

**Ridgeline**:
The Analytics chart with one ridge per month of the date range, oldest at the top: along each ridge, x is the day of the month (UTC) and the height is that day's elevation gain, on one height scale shared by every month. Each day's gain is a narrow peak inside that day, so a ridge never shows climbing on a day without any. Each row is labelled with the month's summed elevation gain.
_Avoid_: joyplot
