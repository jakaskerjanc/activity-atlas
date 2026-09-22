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
An inclusive span of whole calendar months (UTC) that an activity's start must fall within.
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
