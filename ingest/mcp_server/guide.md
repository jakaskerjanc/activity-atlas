# Activity Atlas data guide

One person's activities (Strava + Garmin, merged and deduplicated) and daily
Garmin wellness data, read-only. Use the tools below; they apply the
definitions in this guide. Every result carries `counted` (rules applied, how
many items were included, how many were left out and why) and `as_of` (how
current the data is). **When you answer, say what was counted** (e.g. "69 runs,
moving time, local calendar years") and mention `as_of` when recency matters.

## Which tool

- Totals, averages and trends by week/month/year and type → `summarize`.
- Finding activities → `list_activities` (filters: types, local date range,
  name, distance, moving time, has HR/GPS, place).
- One activity in full (laps, HR zones, gear, Strava/Garmin links) →
  `get_activity`; its samples along the route → `activity_samples`.
- Summits and passes the owner has reached ("how often have I been up
  Slavnik?") → `places` lists them with counts, then
  `list_activities(place=…)` or `summarize(place=…)`.
- "Other times on this route" → `same_route` with an activity id.
- Anywhere else (a town, a lake, a point the owner may only have passed): first
  `find_place` to turn a name into coordinates (confirm with the user when
  several candidates fit), then `activities_near`. Use coordinates you already
  know only when you are sure of them.
- Daily wellness (resting HR, HRV, sleep, steps, stress, body battery,
  respiration, weight) → `wellness`; one day's all-day series → `wellness_series`.
- Anything else → `query` (read-only SQL). Prefer the tools above when they
  cover the question, and say so when you fall back to `query`.
- `sync` checks R2 for a newer database right now (it also happens by itself
  at most once an hour).

## Definitions the tools apply

- Activities: only visible ones (the set the owner's site shows) unless
  `include_hidden` is set.
- Dates and periods use the activity's local start date (`start_local`), not
  UTC. Weeks start on Monday.
- Types are not grouped: "running" means type `Run` unless you list more
  types (e.g. `TrailRun`). Check which types exist in the coverage below.
- Pace and speed over a set = total moving time / total distance, over
  activities that have both. Never the mean of per-activity paces. Elapsed
  time is reported separately.
- Average heart rate over a set = each activity's avg HR weighted by its
  moving time, over activities that have both.
- Unknown values are left out of sums and counted in `counted.excluded`; they
  are never treated as 0.
- No hidden thresholds: a minimum distance or duration is a parameter you set,
  and it appears in `counted.rules`.
- Places are found from the tracks: an activity whose highest point is at
  least 50 m above its start reaches a place, and tops within 500 m of a
  place's first top join it.
  Place names are automatic (an OSM peak or pass, words repeated in the
  activity names, or "Top at … m") unless the owner named it; `name_source`
  says which. The `place` filter takes a place id or a name, with case and
  accents ignored ("smarna gora" matches "Šmarna gora"); a name that several
  places share matches them all, and `counted.rules` says so. For summits the
  owner has reached, prefer it over `find_place` + `activities_near`.
- Same-route groups hold visible activities of one type with a similar
  distance that follow the same line. Their names are automatic too.

## Units

distance m (tools also give km), times s (tools also give min/h), speed m/s
(tools also give km/h), elevation m, heart rate bpm, sleep_s seconds, weight
kg, respiration breaths/min, HRV ms, stress 0–100, lat/lon degrees.

## Tables (for `query`)

- `activities`: one row per activity. `start_time` is UTC ISO, `start_local`
  local ISO without offset, `visible` 1/0, `hr_zone_seconds` JSON.
- `activity_sources`: the Strava/Garmin records behind an activity, with `url`.
- `laps`: joined by `laps.file_sha256 = activities.streams_sha256`.
- `activity_gear`, `gear`: gear per activity.
- `daily_stats`: one row per local date of wellness numbers.
- `places` (`id`, `name`, `name_source`, `kind`, `ele`) and `route_groups`
  (`id`, `name`, `name_source`): a group's id is its first activity's id.
- `activity_groups`: `activity_id` → `place_id` and `route_id` (either can be
  NULL).
- `streams`, `daily_series`: compressed sample blobs; SQL cannot read them,
  use `activity_samples` / `wellness_series`.
- `daily_stats.raw`, `activity_sources.summary_json` and
  `activity_sources.reported` read as NULL: they are large raw payloads and can
  hold private notes.

## Known limits

- All-day stress and respiration series end on the date of the last Garmin
  export: the Garmin API has no all-day stress or respiration. Daily stress and
  respiration numbers continue in `daily_stats`.
- Pulse ox is off on the watch, so SpO2 is mostly empty.
- New activities arrive once a day (the daily Garmin fetch, around 04:17 UTC),
  so something recorded in the last hours may not be in the data yet.
- A database written before places existed has none until the next write
  job; until then `places`, `same_route` and the `place` filter say so.
