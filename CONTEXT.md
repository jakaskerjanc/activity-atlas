# strava-on-maps

A personal map of every recorded activity (Strava + Garmin), drawn as routes over a base map with filtering, coloring, and a chronological replay.

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
The user's current choice of which activities are shown: a type selection plus a date range.
_Avoid_: activity window, view, selection

**Type selection**:
The set of activity types currently switched on. Empty means no activities are shown; there is no separate "all" state. On load it holds Run, Hike, Walk and Ride (those the data has, or every type when it has none of them).
_Avoid_: enabled types, type filter

**Date range**:
An inclusive span of whole calendar months (UTC) that an activity's start must fall within. Clicking a month in the ridgeline narrows it to that month (isolating the month); clicking the month again restores the range it had before.
_Avoid_: date window, time window

**Visible activities**:
The activities that pass the activity filter.
_Avoid_: filtered features, shown set

**Type count**:
How many activities of a type fall inside the date range, regardless of whether that type is switched on.

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

### Pages

**Map** / **Analytics**:
The two pages. Both show the visible activities, under one shared activity filter.
_Avoid_: tab, screen, dashboard

**Active day**:
A calendar day (UTC, like the date range) with at least one visible activity.

**Streak**:
A run of consecutive active days.

**Route profile**:
An activity's elevation every 100 m of distance, measured from its start (profiles.json), so a loop starts and ends near 0 wherever it was.
_Avoid_: elevation profile (that is the selected activity's chart)

**Grade**:
How steep a route is at a point: rise over run in %, read from its route profile. The map's Elevation color mode colors each route along its length by grade, on a fixed scale: green within ±1%, climbs through yellow and red to dark red, descents through blue to dark blue, saturating at ±15%.
_Avoid_: gradient (that is the color ramp), slope

**Distance comparison**:
The Analytics card ("How far is that?") that turns the visible activities' distance into one trip from Ljubljana: for rides, and for runs, walks and hikes together (on foot), a city about that far by bike or on foot, and how much of the way the total covers.
_Avoid_: city match (that is the picking step)

**City route**:
A distance comparison's route from Ljubljana to its city, drawn dashed on the map after "Show on map". It follows the activity filter, and gives way to a selected activity or replay.

**Elevation profiles** (chart):
The Analytics chart that draws every visible activity's route profile as a see-through line against distance in km, in its activity type's color; repeated climbs darken where the lines stack up.
_Avoid_: heatmap

**Ridgeline**:
The Analytics chart with one ridge per month of the date range, oldest at the top: along each ridge, x is the day of the month (UTC) and the height is that day's elevation gain, on one height scale shared by every month. Each row is labelled with the month's summed elevation gain.
_Avoid_: joyplot
