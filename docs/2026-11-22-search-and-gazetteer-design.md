# Design: place lookup, text search, and why not embeddings yet

Date: 2026-11-22
Status: draft for the owner's review
Scope: what is left on issue #35 after PR #45 (places and same-route groups):
§2 (place lookup, which the issue calls the offline gazetteer) and §3 (text
and semantic search), plus the example queries and sizes from "Done when".
Builds on
[2026-11-08-place-tags-design.md](2026-11-08-place-tags-design.md),
[2026-11-09-activity-embeddings-research.md](2026-11-09-activity-embeddings-research.md)
and [2026-11-04-mcp-server-design.md](2026-11-04-mcp-server-design.md).
Plans: [plan 1, place lookup and "near"](2026-11-22-search-and-gazetteer-plan-1.md),
[plan 2, text search and the remaining example queries](2026-11-22-search-and-gazetteer-plan-2.md).

## Intent

The owner asks an LLM about their activities through the MCP server, and two
kinds of question are still weak:

- **"Hiking near Jesenice".** `find_place` gets candidates from Nominatim,
  in Nominatim's order. For Jesenice that's the Slovenian municipality and
  town first, then seven places in Czechia and Croatia. On the owner's data
  no hike comes within 5 km of the town, so `activities_near` returns a
  bare zero, and the LLM can't tell "nothing near" from "wrong place".
- **Words.** `name_contains` ignores accents in neither direction: "smarna"
  finds 0 activities, "Šmarna" finds 5. It looks only at the name, and 333
  of 547 names are defaults like "Morning Hike". Place and route names, and
  the descriptions, can't be searched at all.

Issue #35 also asks for embeddings. The research note recommended them for a
fuzzy tier of queries. This design checks that recommendation against the
queries the owner actually asks, now that places, same-route groups and geo
search exist, and concludes **not yet** (see [Semantic search](#semantic-search-not-yet)).

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

- **`find_place` puts the candidates near the owner's own activities
  first,** and gives each a suggested radius for `activities_near`. When
  several fit, the LLM still confirms with the user, as the guide says.
- **`activities_near` says how close the nearest activity came** when none
  is inside the radius.
- **One `text` filter,** shared by `list_activities` and `summarize`,
  matches words from the start, with case and accents ignored. It looks in
  the name, type, place name, route name and descriptions.
- **Example queries pass as tests on a fixture:** the existing Slavnik one,
  and "hiking near Jesenice" plus seven more. Nominatim is mocked with the
  shapes it really returned on 2026-11-22.
- **Sizes are measured and written down.** The database doesn't grow.

## Non-goals

- **An offline gazetteer** (owner, for now). The appendix says what it
  would take.
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
  A two-word query takes 0.5 ms. Scanning 10,940 rows (20× today) in
  Python takes 6 ms.
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
its first hit was the right one for four of the five. For Slavnik, that was
luck in the order: the right hit had the lower importance score. "Vršič" can't
be answered by Nominatim at all. The owner's own Places list has "Prelaz
Vršič" (one ride), so that query goes through the `text` filter (plan 2) or
`places`, not `find_place`.

### The target queries on real data, with today's tools

- **"All hikes to Slavnik"**: `list_activities(types=[Hike], place=Slavnik)`
  gives 30.
- **"Hiking near Jesenice"**: `activities_near` finds no hike within 1, 3 or
  5 km of the town. One ride passes 473 m from it, and the nearest hikes
  come 12.3 km away. An empty answer with nothing else in it would leave
  the LLM guessing. That's why `activities_near` gains `nearest`.
- **"Rides over Vršič"**: the place exists (Prelaz Vršič, 1 activity), and
  `activities_near` at 200 m finds the same ride. But `place="Vršič"` fails
  today, because the place filter wants the whole name.
- **"Runs from Ljubljana"**: 121 runs start within 3 km of the centre, 131
  within 8 km.

## Place lookup: Nominatim, ranked by the owner's activities

### Approaches considered

| | How | Verdict |
|---|---|---|
| A | An offline gazetteer from the archived OSM snapshots (appendix) | Not now (owner): 7 tasks and a 28 MB file, to do what Nominatim already does |
| **B** | Keep Nominatim, ask for 10 candidates, and re-rank them by the owner's activities nearby | **Chosen.** Small, and it fixes the ambiguity that actually bites |
| C | Keep `find_place` as it is | The LLM has to pick among 9 Jesenices with nothing to go on |

### What changes in `find_place`

1. **The request asks for `limit=10`** (was 5). Nominatim allows up to 40.
   10 covers Jesenice's 9 and keeps the response small.
2. **The cache stores all 10, as Nominatim gave them.** It also keeps
   `addresstype`, `boundingbox` and Nominatim's position for each. The
   ranking runs at call time, since activities change and the cache
   shouldn't.
   - The cache file becomes `data/mcp/places-v2.json`. Old entries hold 5
     candidates without those fields.
   - The server deletes `data/mcp/places.json` on start. It holds only past
     search texts (my call).
3. **`activities_nearby`** per candidate: the number of visible activities
   whose bounding box (`min_lat`…`max_lng`), widened by **2 km**, holds the
   candidate's point.
   - It's one SQL read of the boxes and a loop in Python.
   - It's a ranking signal only. `activities_near` gives the exact answer.
4. **Rank** by:
   1. any activity nearby (yes first)
   2. `activities_nearby` (more first)
   3. Nominatim's own order

   **Return the top 5,** with `total_candidates`.

   For Jesenice, the two Slovenian candidates come first and the Czech ones
   drop back. For Slavnik, the Slovenian peak is first because of the
   owner's 30 hikes, not by luck of the order. When nothing has activities
   nearby, Nominatim's order stands.
5. **`suggested_radius_m`** per candidate, for `activities_near`. The kind
   is the candidate's `addresstype`, else its `type`.

   | Kind | Radius |
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

   - **Any other kind** (a municipality, a county, a road): half the
     diagonal of Nominatim's `boundingbox`, rounded to 100 m, kept between
     200 m and 50 km.
   - These are my call. The peak radius is the MCP design's default 200 m.
     A walk around Lake Bled stays about 500 m from its centre.
   - The LLM sees the radius and may pick another, and the radius used
     shows in `activities_near`'s rules.
6. **The result:**
   - each candidate keeps its current fields (`name`, `kind`, `lat`, `lon`,
     `elevation_m`, `country`) and gains `activities_nearby` and
     `suggested_radius_m`
   - `data` gains `total_candidates`
   - `counted.rules` gains: "ranked: candidates near your activities first,
     then Nominatim's order"
   - `counted.excluded` gains: "more candidates not shown"
7. **Unchanged:** the one-request-a-second wait, the User-Agent, the error
   on failure (the LLM is told to ask the user or use coordinates it's sure
   of), and the `open_world` annotation.

### `activities_near` when nothing is inside

When `total` is 0, the result gains `nearest`: the activity of the same
filter and mode whose route came closest, searched out to `MAX_RADIUS_M`
(50 km), as `{id, date_local, type, name, closest_m}`, or null. The counted
rule says "nearest outside the radius: 12.3 km". On real data this turns
"hiking near Jesenice" into "no hikes within 3 km; the closest came
12.3 km away" instead of a bare zero. It costs a second candidate pass with a
wider box, and only when the first finds nothing.

### What changes for the owner

- **README:** unchanged. It already says place names go to Nominatim.
- **`guide.md`, "Which tool":** the `find_place` line says:
  - candidates near the owner's activities come first, with
    `activities_nearby`
  - start from `suggested_radius_m`
  - for a summit or pass the owner reached, `places` and the place filter
    come first. Nominatim may not even list it: "Vršič" returns ten peaks
    and not the pass.

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
- **The counted rule:** `text: "cold rain" (whole words, case and accents
  ignored; name, type, place, route or description)`. Rows never carry the
  description.
- **`name_contains`** stays, for compatibility, but folds accents now
  (`instr(fold(a.name), fold(?))`). "smarna" finds the 5 it misses today.
- **Hidden activities:** the table has every activity, and
  `include_hidden` works as for any filter.
- **Places found by part of their name:** `text="vršič"` finds the ride to
  "Prelaz Vršič", which `place="Vršič"` doesn't. The place filter keeps
  exact-name matching. The guide points the LLM to `text` when a place
  name doesn't resolve.

### One more filter: climbing

`min_gain_m` and `max_gain_m` in `ActivityFilter`. The research note's main
finding was that numbers in a query must become filters, because
embeddings can't compare them. Distance and moving time already have
filters; elevation gain is the one missing that hiking questions ask for
("hikes over 1,000 m"). Same rules as `min_distance_m`: an unknown gain
fails the filter, and the rule appears in `counted`.

### Search tool: no new tool

`list_activities` and `summarize` take `text` and `min_gain_m`/`max_gain_m`.
`activities_near` doesn't take them; if it needs to, that's a parameter
later. A separate `search_activities` tool would repeat every filter and
make the LLM choose between two tools that do the same thing. The guide
gets one line: "Words → `list_activities(text=…)`: whole words, case and
accents ignored, in name, type, place, route and description." The
`counted`/`as_of` conventions are unchanged.

## Semantic search: not yet

The research note recommended a text-card embedding (EmbeddingGemma-300m)
for a "fuzzy tier" of queries, after filters. Checked against what's now
built:

- **The client is an LLM.** It already turns "big mountain day" into
  `types=[Hike], min_gain_m=1000`, "easy jog" into a short run with low
  HR, and "autumn evenings" into dates and a `query` on `start_local`. A
  card embedding would encode those same columns as words, and the
  research note shows that's where embeddings are weakest (numbers at
  chance level).
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
categories, types, addresstypes and order. Each test calls the tools
through the server the way an LLM would, and checks the activity ids. One
file, `ingest/tests/test_mcp_queries.py`, with the query as each test's
docstring.

| # | Query | Tool calls | Expected | Plan |
|---|---|---|---|---|
| 1 | All hikes to Slavnik | `list_activities(types=[Hike], place="slavnik")` | the two Slavnik hikes (exists today; moves into the file) | 2 |
| 2 | Hiking near Jesenice | `find_place("Jesenice")` → the Slovenian candidates first (the Czech ones have no activities nearby), the town with `suggested_radius_m` 3000 → `activities_near(…, 3000, types=[Hike])` | the hike up from Jesenice; not the walk in town; not the Slavnik hikes | 1 |
| 3 | Hiking near Jesenice, none close | the same on a fixture with no hike inside 3 km | `total` 0, `nearest` is the hike 12 km away | 1 |
| 4 | Slavnik, when the mock puts the Serbian village first | `find_place("Slavnik")` | the SI peak first, because of the hikes nearby | 1 |
| 5 | Walks around Lake Bled | `find_place("Lake Bled")` → Blejsko jezero, `suggested_radius_m` 500 → `activities_near(…, 500, types=[Walk])` | the lake walk | 1 |
| 6 | Runs from Ljubljana | `find_place("Ljubljana")` → the city → `activities_near(…, 5000, mode="start", types=[Run])` | the two runs that start there | 1 |
| 7 | Rides over Vršič | `list_activities(types=[Ride], text="vršič")` | the Vršič ride, through its place name "Prelaz Vršič" | 2 |
| 8 | Šmarna gora, typed without accents | `list_activities(text="smarna gora")`, and `name_contains="smarna"` | the activity at Šmarna gora | 2 |
| 9 | Cold rainy walks | `list_activities(types=[Walk], text="cold rain")` | the walk whose description says "Rain, Cold". Not a WeightTraining. The row has no description | 2 |
| 10 | Hikes over 1,000 m of climbing in a given year | `list_activities(types=[Hike], min_gain_m=1000, date_from=…, date_to=…)` | the one big hike; a hike with unknown gain doesn't pass | 2 |

## Sizes and budget

- **The database: no change** (45.6 MB today). The text table is TEMP, on
  the server's connection, and never written to the file.
- **The place cache** (`data/mcp/places-v2.json`): a few KB per hundred
  names. It's local only and never uploaded.
- **Gazetteer and vectors:** none.

Plan 2 ends with the text-search numbers measured again on the owner's data
and written into this section.

## Left to the builder

- Function names.
- The exact Nominatim mock bodies, kept to the fields the code reads and
  shaped like the 2026-11-22 responses.

## Calls I made (check these)

- `limit=10`, and re-ranking by activities nearby within 2 km of their
  bounding boxes.
- The suggested radii above, and the bounding-box rule for other kinds.
- `activities_near` returns `nearest` when nothing is inside the radius.
- A new cache file, with the old one deleted on start.
- Text matches from the start of a word, not anywhere in it. This differs
  from the site's search, which matches anywhere (see the open questions).
- `min_gain_m`/`max_gain_m` added.
- No new search tool.

## Open questions for the owner

- **The site's search matches anywhere in a word** ("rain" finds
  WeightTraining). Should it match from word starts like the MCP server?
  It's a one-line change in `activityMatcher`, but it changes how the page
  behaves today ("brdo" would no longer find "Novobrdo").
- **A geo filter in `summarize`:** "how many km did I hike near Jesenice
  this year" needs `activities_near`'s answer as a filter. A `near` part
  in `ActivityFilter` (lat, lon, radius, mode) would give every tool geo.
  It isn't in these plans; it costs decoding tracks inside the filter.
- **Weather as columns:** the 248 weather lines could be parsed into
  temperature and conditions, for "walks below 0 °C". Word matching
  covers "cold" and "rain" but not numbers. Not in these plans.

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
