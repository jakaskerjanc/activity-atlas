# Design: text search, "nearest", and why not a gazetteer or embeddings yet

Date: 2026-11-22
Status: draft for the owner's review
Scope: what is left on issue #35 after PR #45 (places and same-route groups):
§2 (place lookup, which the issue calls the offline gazetteer) and §3 (text
and semantic search), plus the example queries and sizes from "Done when".
Builds on
[2026-11-08-place-tags-design.md](2026-11-08-place-tags-design.md),
[2026-11-09-activity-embeddings-research.md](2026-11-09-activity-embeddings-research.md)
and [2026-11-04-mcp-server-design.md](2026-11-04-mcp-server-design.md).
Plan: [2026-11-22-search-and-gazetteer-plan.md](2026-11-22-search-and-gazetteer-plan.md).

## Intent

The owner asks an LLM about their activities through the MCP server. Most of
what #35 asks for can already be answered with today's tools, `query`
included, if the LLM does a little more work. Two things can't, or go wrong:

- **Descriptions can't be searched at all.** They exist only in
  `activity_sources.summary_json`, which `query` blocks and `get_activity`
  doesn't return. "Cold rainy walks", or "the hike where I wrote about X",
  is impossible today. Words in names are weak too: `name_contains` ignores
  accents in neither direction ("smarna" finds 0 activities, "Šmarna"
  finds 5), and 333 of 547 names are defaults like "Morning Hike".
- **"Hiking near Jesenice" returns a bare zero.** On the owner's data no
  hike comes within 5 km of the town, so `activities_near` says "none", and
  the LLM can't tell "nothing near" from "wrong place" or "radius too
  small".

Issue #35 also asks for an offline gazetteer and for embeddings. This design
checks both against the queries the owner actually asks, now that places,
same-route groups and geo search exist, and concludes **not yet** for both
(see [Place lookup](#place-lookup-nominatim-as-it-is) and
[Semantic search](#semantic-search-not-yet)).

## Owner decisions (2026-11-22)

- **Nominatim stays, for now.** No offline gazetteer is built. The owner
  first chose to drop Nominatim, then reversed that once the cost was clear:
  - an offline list would only matter without a network, and the MCP
    client (Claude) doesn't work without one anyway
  - only the place name leaves the machine, it's cached, and the same name
    is already in the conversation
  - Nominatim covers every country, every language and streets, which a
    list built from our snapshots wouldn't

  What was measured for the offline list is kept in the appendix, for
  later.
- **Build only what's new or prevents a wrong answer.** That is:
  1. the `text` filter, the only new capability
  2. `nearest` in `activities_near`
  3. the example-query tests that "Done when" asks for

  Re-ranking `find_place`'s candidates, a suggested radius and an
  elevation-gain filter were designed and then cut. The LLM can already do
  each with today's tools (see [Considered and cut](#considered-and-cut)).
- **Descriptions are matched, never shown.** Text search matches the words
  in Strava descriptions, but no tool returns description text, and the
  `query` tool keeps blocking `summary_json`.
- **No site change.** The Activities page keeps its own search
  (`app/src/activitySearch.ts`).

Earlier decisions this design keeps: no network in the daily CI job; OSM
points live in their own file, not in the database (2026-11-21); huts,
lakes, protected areas, settlements, elevation band and season are not tags
(place-tags design).

The issue's "`find_place` works offline. Any network fallback is opt-in and
documented" no longer holds as written. When the owner updates #35, it
becomes: "`find_place` sends only the place name to Nominatim, caches it, and
the README says so."

## Goals

- **One `text` filter,** shared by `list_activities` and `summarize`,
  matches words from the start, with case and accents ignored. It looks in
  the name, type, place name, route name and descriptions.
- **`name_contains` ignores accents.**
- **`activities_near` says how close the nearest activity came** when none
  is inside the radius.
- **Example queries pass as tests on a fixture:** the existing Slavnik one,
  "hiking near Jesenice", and six more. Nominatim is mocked with the shapes
  it really returned on 2026-11-22.
- **Sizes are measured and written down.** The database doesn't grow.

## Non-goals

- **An offline gazetteer** (owner, for now). The appendix says what it
  would take.
- **Changes to `find_place`.** It stays as it is: Nominatim, 5 candidates in
  Nominatim's order.
- **Embeddings, vectors and `sqlite-vec`.** See below for why, and for what
  would change that.
- **"Similar activities"** (numeric features + Fréchet, from the research
  note). It's a separate feature, not search, and needs its own design.
- **Areas:** "hikes in Austria" or "in Triglav National Park". Nominatim
  returns a bounding box, not a polygon, and `activities_near` works on a
  point and radius.
- **Tags per activity.** No nearest town at the start, no huts passed.
  "Near X" is answered at query time by geo, as #35 asks.
- **Site changes** (owner).
- **A geo filter in `summarize`** ("km hiked near Jesenice"). See the open
  questions.

## Anti-goals

- **More than the place name leaving the machine.** No coordinates, no
  activity data, no owner identity in the request. The User-Agent names
  the app, not the owner, as today.
- **A database that grows for search.** Every writer, the deploy and the MCP
  server pull the database.
- **Description text in tool output.** A match may say that an activity's
  description has the words, but never what it says.
- **Search that disagrees with itself.** The place filter and the `text`
  filter fold names with the same function (`fold_name`), as the site's
  `normalizeName` does.

## Measured on the owner's data (2026-11-22)

Read-only, on `data/activities.sqlite` synced from R2, with scratch scripts
that aren't committed. The Nominatim results come from five requests with
the server's User-Agent, sending only the place names.

### The database

45,588,480 bytes (11,130 pages of 4 KB, schema v6), 547 activities (all
visible), 454 with GPS. By `dbstat`:

| Table | Bytes |
|---|---|
| `streams` | 16,793,600 |
| `daily_stats` | 10,575,872 |
| `activity_sources` | 7,737,344 |
| `daily_series` | 3,137,536 |
| `activities` | 1,785,856 |
| `raw_files` | 1,736,704 |
| `wellness_inputs` | 1,503,232 |
| indexes, `laps` and the rest, including the place and route tables (about 45,000) | 2,318,336 |

### Text there is to search

- **Names:** 333 of 547 are default names (`naming.is_default_name`).
- **Places:** 253 activities have a place (109 places), and 71 are in a
  same-route group (21 routes).
- **Descriptions:** there's no description column. Descriptions exist only
  in Strava's `summary_json` (`Activity Description`), on 393 of 490 Strava
  source rows, averaging 42 characters. Garmin has none, and private notes
  are empty.
  - 248 are automated weather lines ("Weather: 12°C, Cold, clear")
  - 113 are Wandrer counts
  - 13 are other strautomator lines
  - 19 are written by the owner, in colloquial Slovenian, some naming
    people
- **Matching from the start of a word matters.** "rain" as a substring hits
  77 activities. 57 of those are "WeightTraining". From the start of a word
  it hits 20, all of them weather lines. "cold" (54) and "clear" (87) come
  out the same either way.

### Text search options

- **FTS5 in the database:** at most 74 KB for all 547 rows, descriptions
  included, with either `unicode61 remove_diacritics 2` or `trigram`.
- **The same index built in memory by the MCP server:** 4.8 ms.
- **An id → folded-text table in TEMP on the server's connection:** 21.6 ms
  to build, including parsing the 393 descriptions out of `summary_json`.
  The bare match for a two-word query takes 0.5 ms. Scanning 10,940 rows
  (20× today) in Python takes 6 ms.
- **FTS5's `unicode61` doesn't fold đ, ł, ø or ß** (tested: "durdevac",
  "lodz", "ovre" and "strasse" find nothing). `fold_name` folds all four,
  as the site's `normalizeName` does.

### What Nominatim returns (limit 10, 2026-11-22)

| Query | What comes back, in Nominatim's order |
|---|---|
| Jesenice | 9: the SI municipality (`boundary/administrative`, addresstype municipality), the SI town (`place/town`), 4 in Czechia, 2 in Croatia, 1 more in Czechia |
| Vršič | 10 peaks named Vršič, all in Slovenia, **none of them the pass** (OSM names it "Prelaz Vršič"). More exist past 10 |
| Lake Bled | 1: Blejsko jezero (`water/lake`) |
| Ljubljana | 2: the city (`place/city`), the municipality |
| Slavnik | 4: the SI peak first (importance 0.186), then a Serbian district and village (0.40), then a Czech peak |

So Nominatim handles alternative names ("Lake Bled") and accents itself, and
its first hit was the right one for four of the five. With today's limit of
5, the two Slovenian Jesenice candidates are the first two returned. "Vršič"
can't be answered by Nominatim at all. The owner's own Places list has
"Prelaz Vršič" (one ride), so that query goes through `places` or the `text`
filter, not `find_place`.

### The target queries on real data, with today's tools

- **"All hikes to Slavnik"**: `list_activities(types=[Hike], place=Slavnik)`
  gives 30.
- **"Hiking near Jesenice"**: `activities_near` finds no hike within 1, 3 or
  5 km of the town. One ride passes 473 m from it, and the nearest hikes
  come 11.8 km away. An empty answer with nothing else in it would leave
  the LLM guessing. That's why `activities_near` gains `nearest`.
- **"Rides over Vršič"**: the place exists (Prelaz Vršič, 1 activity), and
  `activities_near` at 200 m finds the same ride. But `place="Vršič"` fails
  today, because the place filter wants the whole name.
- **"Runs from Ljubljana"**: 121 runs start within 3 km of the centre, 131
  within 8 km.

## Place lookup: Nominatim as it is

### Approaches considered

| | How | Verdict |
|---|---|---|
| A | An offline gazetteer from the archived OSM snapshots (appendix) | Not now (owner): 7 tasks and a 28 MB file, to do what Nominatim already does |
| B | Keep Nominatim, ask for 10 candidates, re-rank them by the owner's activities nearby, and suggest a radius for each | Cut (owner): the LLM can call `activities_near` on each candidate and pick a radius itself. See [Considered and cut](#considered-and-cut) |
| **C** | Keep `find_place` as it is. `activities_near` says how close the nearest activity came when nothing is inside | **Chosen.** One small change, and it stops the one answer that misleads |

### `activities_near` when nothing is inside

When `total` is 0, the result gains `nearest`: the activity of the same
filter and mode whose route came closest, searched out to `MAX_RADIUS_M`
(50 km), as `{id, date_local, type, name, closest_m}`, or null. The counted
rule says "nearest outside the radius: 11.8 km". On real data this turns
"hiking near Jesenice" into "no hikes within 3 km; the closest came
11.8 km away" instead of a bare zero. It costs a second candidate pass with a
wider box, and only when the first finds nothing.

### What changes for the owner

- **README:** unchanged. It already says place names go to Nominatim.
- **`guide.md`, "Which tool":** the `find_place` line adds that for a summit
  or pass the owner reached, `places` and the place filter come first, and
  `text` finds a place by part of its name. Nominatim may not even list it:
  "Vršič" returns ten peaks and not the pass.

  Definitions gains `nearest`.

## Text search

### Approaches considered

| | How | For | Against | Verdict |
|---|---|---|---|---|
| A | FTS5 table in the database, kept by `refresh` | What #35 says. BM25 ranking, prefix queries | Schema bump (v7) and a rebuild. A sync step on every write that has to keep the file byte-identical. `unicode61` disagrees with `fold_name` on đ, ł, ø and ß. Descriptions would sit in a table that `query` can read unless it's blocked too | No |
| B | FTS5 built in memory when the MCP server opens the database | No schema change. BM25 | Same folding mismatch. BM25 over 2–6-word names has nothing to rank | No |
| **C** | A TEMP table `activity_text(id, folded)` on the server's own connection, built when it opens or reopens the database. A `text` filter in `ActivityFilter` matches every query word from the start of a word | Same folding as the place filter and the site. Zero bytes in the database. Never out of date, since it's rebuilt on every reopen. 21.6 ms to build, 0.5 ms to query | No relevance ranking, so results sort by date, distance and so on as now | **Chosen** |

Approach C answers the issue's four FTS questions this way:
- **Schema:** none in the database.
- **Tokenizer:** `fold_name` plus word starts.
- **Staying in sync:** rebuilt on every reopen, and the server already
  reopens whenever the file changes.
- **Size:** 0 bytes.

Revisit FTS5 when there's long text to rank: tens of thousands of
activities, or owner-written notes that run to paragraphs.

### The filter

- **`ActivityFilter.text: str | None`.** The query is folded and split on
  whitespace. An activity matches when every word starts a word of its
  search text. A word starts where the text starts, or after a character
  that isn't a letter or a digit.
- **The search text** is the name, the type, the type split into words
  ("WeightTraining" → "weight training"), the place name, the route name,
  and every Strava `Activity Description` of its live sources. Fields are
  joined with newlines, so a word never spans two fields.
- **The TEMP table** lives only on `Database.conn`. `query_conn` is a
  separate connection, so the `query` tool can't see the table, and
  `summary_json` stays blocked there.
- **SQL:** `a.id IN (SELECT id FROM temp.activity_text WHERE words_match(folded, ?))`.
  `words_match` is a deterministic Python function registered on `conn`.
  It's one function, not one `instr` per word, because "from the start of
  a word" doesn't fit `instr`.
- **The counted rule:** `text: "cold rain" (each word from the start of a
  word, case and accents ignored; name, type, place, route or description)`. Rows never carry the
  description.
- **`name_contains`** stays, for compatibility, but folds accents now
  (`instr(fold(a.name), fold(?))`). "smarna" finds the 5 it misses today.
- **Hidden activities:** the table has every activity, and
  `include_hidden` works as for any filter.
- **Places found by part of their name:** `text="vršič"` finds the ride to
  "Prelaz Vršič", which `place="Vršič"` doesn't. The place filter keeps
  exact-name matching. The guide points the LLM to `text` when a place
  name doesn't resolve.

### Search tool: no new tool

`list_activities` and `summarize` take `text`. `activities_near` doesn't;
if it needs to, that's a parameter later. A separate `search_activities`
tool would repeat every filter and make the LLM choose between two tools
that do the same thing. The guide gets one line: "Words →
`list_activities(text=…)`: each word from the start of a word, case and
accents ignored, in name, type, place, route and description." The `counted`/`as_of` conventions are
unchanged.

## Semantic search: not yet

The research note recommended a text-card embedding (EmbeddingGemma-300m)
for a "fuzzy tier" of queries, after filters. Checked against what's now
built:

- **The client is an LLM.** It already turns "big mountain day" into hikes
  sorted by elevation gain, "easy jog" into a short run with low HR, and
  "autumn evenings" into dates and a `query` on `start_local`. A card
  embedding would encode those same columns as words, and the research
  note shows that's where embeddings are weakest (numbers at chance level).
- **Where words live, word matching is enough.**
  - Places and routes have names, and the `place` filter and `text` cover
    them.
  - Descriptions are 361 automated lines in fixed English ("Weather: 12°C,
    Cold, clear"), which word matching handles ("cold rain").
  - The 19 owner-written lines are too few for a vector to beat reading
    them.
- **Location is geo, not vectors** (#35). `find_place` and
  `activities_near` cover it.
- **Cost:**
  - a model download of 0.3–1.2 GB and a PyTorch or ONNX runtime, against
    seven pinned Python dependencies today
  - vectors computed on the owner's machine only (no network in CI for
    this), so a side file that can go stale
  - fp32-on-CPU pinning to keep results deterministic
- **Every example query below passes without vectors.**

**What would change this:** a query the owner actually asks that filters,
places, geo and `text` all miss. Write it into the example-query test file
as an expected failure. When two or three of those collect, run the
research note's afternoon experiment on them. Two other things would
reopen it: owner-written notes growing to hundreds, or the site wanting
free-text search without an LLM behind it. If vectors ever come, the note's
storage call stands: a BLOB column or side file plus numpy (547 × 768
float32 is 1.68 MB), not `sqlite-vec`.

## Example queries

They run on the MCP fixture (`ingest/tests/mcp_fixture.py`, extended with a
few synthetic activities around real place coordinates). Nominatim is
mocked with responses shaped like the 2026-11-22 ones above: the same
categories, types, addresstypes and order, cut to today's 5. Each test calls
the tools through the server the way an LLM would, and checks the activity
ids. One file, `ingest/tests/test_mcp_queries.py`, with the query as each
test's docstring. Where a query needs a radius, the test picks it as an LLM
would; no tool suggests one.

| # | Query | Tool calls | Expected |
|---|---|---|---|
| 1 | All hikes to Slavnik | `list_activities(types=[Hike], place="slavnik")` | the two Slavnik hikes (exists today; moves into the file) |
| 2 | Hiking near Jesenice | `find_place("Jesenice")` → the Slovenian town (second, after the municipality) → `activities_near(…, 3000, types=[Hike])` | the hike up from Jesenice; not the walk in town; not the Slavnik hikes |
| 3 | Hiking near Jesenice, none close | the same, with a date range that leaves out that hike | `total` 0, `nearest` is the hike 12 km away |
| 4 | Walks around Lake Bled | `find_place("Lake Bled")` → Blejsko jezero → `activities_near(…, 700, types=[Walk])` | the lake walk |
| 5 | Runs from Ljubljana | `find_place("Ljubljana")` → the city → `activities_near(…, 5000, mode="start", types=[Run])` | the two runs that start there |
| 6 | Rides over Vršič | `list_activities(types=[Ride], text="vršič")` | the Vršič ride, through its place name "Prelaz Vršič" |
| 7 | Šmarna gora, typed without accents | `list_activities(text="smarna gora")`, and `name_contains="smarna"` | the activity at Šmarna gora |
| 8 | Cold rainy walks | `list_activities(types=[Walk], text="cold rain")` | the walk whose description says "Rain, Cold". Not a WeightTraining. The row has no description |

## Sizes and budget

- **The database: no change** (45.6 MB today). The text table is TEMP, on
  the server's connection, and never written to the file.
- **The place cache** (`data/mcp/places.json`): unchanged, local only and
  never uploaded.
- **Gazetteer and vectors:** none.

Measured again after the build, read-only on the same synced copy
(2026-11-22):

- **The database: still 45,588,480 bytes** (11,130 pages of 4 KB), with
  the same checksum before and after opening it through the server.
- **Building `activity_text`:** 18 ms (median of 10; 17 to 25 ms), one row
  for each of the 547 activities.
- **A two-word `list_activities(text=…)` call:** about 4 ms, the whole call
  with its rows ("cold rain" 3.8 ms, "smarna gora" 3.6 ms). The bare match
  inside it is the 0.5 ms measured before the build.
- **Hits as words:** "rain" 20 and "cold" 54, the same as measured
  before the build. "cold rain" together: 1.
- **`nearest`, when nothing is inside the radius:** it searches again out
  to 50 km, so it costs what a 50 km search costs.
  - Hikes near Jesenice, 3,000 m: 525 ms, nearest 11.8 km away.
  - Swims near Ljubljana: 2 ms.
  - No type filter, 200 m, at 46.12, 14.8: 2,283 ms, nearest 1.2 km away.
    This is the worst case: with no type filter the 50 km pass decodes many
    tracks. It runs only when the radius finds nothing.

## Left to the builder

- Function names.
- The exact Nominatim mock bodies, kept to the fields the code reads and
  shaped like the 2026-11-22 responses.

## Calls I made (check these)

- `activities_near` returns `nearest` when nothing is inside the radius,
  searched out to 50 km, with the same filter and mode.
- Text matches from the start of a word, not anywhere in it. This differs
  from the site's search, which matches anywhere (see the open questions).
- No new search tool.

## Open questions for the owner

- **The site's search matches anywhere in a word** ("rain" finds
  WeightTraining). Should it match from word starts like the MCP server?
  It's a one-line change in `activityMatcher`, but it changes how the page
  behaves today ("brdo" would no longer find "Novobrdo").
- **A geo filter in `summarize`:** "how many km did I hike near Jesenice
  this year" needs `activities_near`'s answer as a filter. A `near` part
  in `ActivityFilter` (lat, lon, radius, mode) would give every tool geo.
  It isn't in the plan; it costs decoding tracks inside the filter.
- **Weather as columns:** the 248 weather lines could be parsed into
  temperature and conditions, for "walks below 0 °C". Word matching
  covers "cold" and "rain" but not numbers. Not in the plan.

## Considered and cut

Designed, then cut by the owner (2026-11-22), because the LLM can do each
with today's tools. Kept here in case real use shows otherwise.

- **Re-ranking `find_place`.** Ask Nominatim for `limit=10`, cache the raw
  candidates, and put first those whose point lies inside some visible
  activity's bounding box widened by 2 km (more such activities first, then
  Nominatim's order). It would fix Slavnik, where the Serbian district
  scores higher than the Slovenian peak (0.40 against 0.186) but comes
  second only by luck of the order. Today the LLM can call `activities_near`
  on each candidate instead. Revisit if it picks the wrong candidate in
  practice.
- **A suggested radius per candidate,** by kind:

  | Kind | m |
  |---|---|
  | city | 5,000 |
  | town | 3,000 |
  | village, suburb | 1,500 |
  | quarter, hamlet | 1,000 |
  | neighbourhood | 800 |
  | lake, water, reservoir | 500 |
  | park | 300 |
  | peak, saddle, mountain_pass | 200 |
  | alpine_hut, wilderness_hut | 150 |

  Any other kind: half the bounding-box diagonal, rounded to 100 m, kept
  between 200 m and 50 km. Today the LLM picks the radius, and it shows in
  `activities_near`'s rules; with `nearest`, a radius that's too small no
  longer reads as "none".
- **`min_gain_m` / `max_gain_m`.** "Hikes over 1,000 m of climbing" works
  today with `query` (`elevation_gain >= 1000`) or by sorting on gain.

## Appendix: an offline gazetteer, measured but not built

For whenever the no-network rule comes back. Measured 2026-11-22 on the
archive's snapshots (AT 10.0 MB, IS 0.9 MB, IT 29.8 MB, NO 28.2 MB, SI
3.9 MB).

- **The refresh's points file can't serve as is.**
  - It's 24,043,520 bytes (11.3 MB gzipped), 328,165 points, `name` only.
  - It has no towns, cities or huts, so "Jesenice", "Bled", "Koper" and
    "Bohinj" find nothing, and "Ljubljana" finds only a peak.
- **Alternative names are already in the snapshots.** In SI, 4,122 of
  19,144 points have `name:*`, `alt_name` or `official_name`.
- **What would need adding,** counted with Overpass (SI / AT):

  | Kind | SI | AT |
  |---|---|---|
  | `place=town\|city` (nodes) | 72 | 229 |
  | `tourism=alpine_hut\|wilderness_hut` | 233 | 1,531 |
  | `place=locality` | 2,006 | 20,317 |
  | `place=isolated_dwelling` | 1,424 | 5,335 |
  | `boundary=national_park\|protected_area` | 207 | 1,499 |
- **Prototype layouts:**

  | Layout | Bytes | gzip |
  |---|---|---|
  | points + folded names + `alt_names`, no index | 28,082,176 | 13.6 MB |
  | the same + B-tree indexes | 39,796,736 | 18.5 MB |
  | FTS5 trigram index | 51,482,624 | 22.3 MB |

  A word-start scan of all names takes 50–80 ms in SQL. A typo fallback
  takes 90 ms.
- **Coverage:** 423 of 454 GPS activities start within 15 km of a loaded
  country. 31 are in six countries not downloaded, 25 of them in Denmark.
- **The way to build it:**
  - a separate derived file, `derived/gazetteer/v1-<hash>.sqlite`, built by
    `places:update` only
  - fetched by the MCP server with the read-only token, which can list
    `osm/` and `derived/` (checked)
  - never in the database, and never pulled by CI

  About 7 tasks. The first version of this design, in this branch's
  history, has the details.
