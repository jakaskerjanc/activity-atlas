# Heart-rate zones on the Analytics page

A new Analytics card, **Heart-rate zones**, over the visible activities:

1. **Distribution:** how the total time with heart rate splits across the zones
   (below zone 1, then zones 1 to 5). The owner asked for this ("lets add
   distribution of time spent in each zone").
2. **By month:** one stacked bar per month of the date range, so you can see
   how hard each month was. This was suggested, not confirmed; it is built
   so it can be dropped without touching the distribution.

The owner asked for this to be built in one go on 2026-11-13, without a design
round. Every choice below that the owner did not make is marked **(my call)**.

## Why

The site already ships each activity's zone seconds, and nothing reads them.
The card answers "how hard do I train?" for whatever the activity filter
shows: a type, a year, a place.

## The problem with the stored zones

The zone seconds in the database were not measured against one set of limits,
so they can't be summed across time (measured 2026-11-12 on the owner's
database, 503 of 531 visible activities with zones):

- **393 activities from 2025-04-19 on** carry the zones the Garmin watch
  wrote into the FIT file. Their limits drift by a beat or two between
  activities (Garmin re-derives them), about `[99, 119, 139, 158, 178, 198]`.
  These have seven values: below zone 1, zones 1–5, and above zone 5's top.
- **110 activities before 2025-04-19** (no watch zones) had their zones
  *calculated* by ingest (`merge.py`, `_closest_zone_limits`) from the limits
  of the nearest activity with zones. The nearest are the watch's first two
  activities, recorded with its factory defaults `[128, 153, 179, 204, 230]`
  before the owner's profile was set. Zone 5 starting at 230 bpm is not a real
  zone. These have six values.

Summed as stored, 2024 reads 54% below zone 1 and 0.2% at zone 3 or higher;
recomputed against the current limits it reads 8% below zone 1 and 31% at
zone 3 or higher.

### Decision (my call): recompute every activity at build time

`build:tracks` recomputes each activity's zone seconds from its heart-rate
stream against **one** set of limits, the **reference limits**: the limits of
the newest visible activity whose zones the watch reported (not calculated).
Today that is `[100, 119, 139, 159, 179, 199]`: zone 1 from 100 bpm, zone 5
from 179 bpm.

- Every activity with a heart-rate stream gets comparable zones, before and
  after the watch.
- The watch's own per-activity numbers are not shown. Against them the
  recomputed zones move a median 2% of an activity's time (90th percentile
  8%), from the drifting limits and from sampling.
- Time above zone 5's top counts in zone 5. The card has six bands.
- **Pauses are left out:** a gap of more than 60 s between two samples counts
  nothing. Without that cap a paused watch counts the pause in the last zone,
  and the recomputed total ran 12% over the watch's; with it, 1% over.
- **No reference limits** (the demo database, a fork without a watch): no
  activity gets zones and the card says so. The stored seconds are not used as
  a fallback, because they are what this decision replaces.

Rejected: summing the stored values and marking or excluding the pre-watch
period. Excluding hides 110 activities (all of 2024) from a card that follows
the activity filter; marking still sums incomparable numbers.

**Not changed:** the database. `activities.hr_zone_seconds` keeps the stored
values, so the MCP server's `get_activity` still reports the factory-default
zones for the 110 pre-watch activities. Fixing `_closest_zone_limits` in
ingest is a separate change.

The pre-watch heart rate also reads higher: weighted average HR of runs 159
vs 148 bpm after, hikes 124 vs 111. That may be the older device or real
fitness change. The card does not try to correct it.

## Goals

- Zone seconds that compare across the whole history.
- A distribution of time across the six bands for the visible activities,
  with hours and percentages.
- A month-by-month view of the same bands.
- Activities without zones are left out, never counted as 0.

## Non-goals

- Trend lines, averages over time, "zone 2 per week" targets.
- Per-type splits inside the card. The type selection already does that.
- Zone limits per activity type or per period.
- Showing the watch's own per-activity zone numbers anywhere.
- Any wellness value (resting HR, HRV). Zones come from activity streams.

## Anti-goals: failure even if it works

- Summing zone seconds measured against different limits.
- An activity without heart rate counted as time below zone 1, or as 0.
- A pause counted as time in a zone.
- The accent orange used for a zone.
- A new runtime dependency for charts.

## Design

### Build (`scripts/build-tracks.ts`, `scripts/zones.ts`)

- `referenceZoneLimits(db)`: `hr_zone_limits` of the newest visible activity
  whose `calculated` does not list `hr_zone_seconds`. The first five values are
  the lower bounds of zones 1 to 5 (this is how ingest reads both the six- and
  five-value forms).
- `zoneSeconds(time, hr, lowerBounds)`: six numbers. Sample *i* lasts until
  sample *i + 1*; a gap over 60 s, a backward step, or a missing HR counts
  nothing. All zeros is unknown (absent).
- `activities.json` keeps version 1 and gains an optional root
  `hr_zone_limits: number[]` (the five lower bounds). `ActivityRecord.hr_zones`
  now holds the recomputed six numbers. Nothing read it before.
- The streams are already decoded for the detail files; the zones reuse them.

### Card

- Section `zones`, "Heart-rate zones", after Active hours, full width.
- Subtitle names the limits: "Time in each zone, from heart rate. Zone 1
  starts at 100 bpm, zone 5 at 179 bpm (your watch's current zones)."
- **Distribution:** a donut of the six bands (2 px gaps), the total hours with
  heart rate in the middle, and beside it a row per band: swatch, name, bpm
  range, hours, percentage. The rows double as the legend and the table view.
  Hovering a segment or a row highlights both and puts that band's share in
  the middle.
- **By month:** one bar per month (UTC months, like the date range), the six
  bands stacked with below zone 1 at the bottom. A toggle switches the scale
  between **Hours** (height is time with heart rate) and **Share** (every
  month is its own 100%). The bars start at the first month with zone time;
  empty months after it stay, as gaps. Hovering a month shows its total and
  each band's hours and share. Axis: a few gridlines, year labels under
  January (and the first month, unless January is too close).
- **No count note.** Activities without zones are left out silently. None
  have zones: "No visible activity has heart-rate zones."

*(Changed after the owner's review on 2026-11-13: the leading empty months
went, the counted note went, the Hours / Share toggle and the donut were
added. The donut replaced a thin 100% strip, which would have shown the same
split twice.)*

### Colors (my call)

Zones are ordinal, so they take one hue in steps, not a rainbow: a violet
ramp (OKLCH hue 300), light to dark in the light theme and dark to light in
the dark theme, so zone 5 always has the most contrast. Below zone 1 is a
neutral grey: it is "not in a zone". Validated with the dataviz ordinal
check (monotone lightness, ≥ 0.06 steps, light end ≥ 2:1 on the surface) on
both themes.

| Band | Light | Dark |
|---|---|---|
| below zone 1 | `#b9bcc4` | `#3d4049` |
| zone 1 | `#ae8ee6` | `#5a358c` |
| zone 2 | `#9769dc` | `#7a4aba` |
| zone 3 | `#7f47c7` | `#9867e1` |
| zone 4 | `#6529a9` | `#b790f7` |
| zone 5 | `#4a177f` | `#d4bcff` |

No activity type is violet among the four main ones; an extra type can be
(`#9085e9`), but this card is never colored by type.

## Glossary

`CONTEXT.md` gains **Heart-rate zones** (the card) and **Reference limits**.
