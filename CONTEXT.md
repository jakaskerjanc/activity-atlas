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
The set of activity types currently switched on. Empty means no activities are shown; there is no separate "all" state.
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
An activity's elevation at 64 evenly spaced fractions of its distance (profiles.json): the shape of one outing, whatever its length.
_Avoid_: elevation profile (that is the selected activity's chart)

**Month signature**:
The per-point median of the route profiles of a month's visible activities, measured from its own lowest point.

**Ridgeline**:
The Analytics chart with one ridge (a month signature) per month of the date range, oldest at the top, each labelled with the month's summed elevation gain.
_Avoid_: joyplot, elevation view
