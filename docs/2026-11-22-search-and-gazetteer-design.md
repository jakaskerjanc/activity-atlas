# Design: offline gazetteer, text search, and why not embeddings yet

Date: 2026-11-22
Status: draft for the owner's review
Scope: what is left on issue #35 after PR #45 (places and same-route groups):
§2 (offline gazetteer) and §3 (text and semantic search), plus the example
queries and sizes from "Done when". Builds on
[2026-11-08-place-tags-design.md](2026-11-08-place-tags-design.md),
[2026-11-09-activity-embeddings-research.md](2026-11-09-activity-embeddings-research.md)
and [2026-11-04-mcp-server-design.md](2026-11-04-mcp-server-design.md).
Plans: [plan 1, the gazetteer](2026-11-22-search-and-gazetteer-plan-1.md),
[plan 2, text search and the example queries](2026-11-22-search-and-gazetteer-plan-2.md).

## Intent

The owner asks an LLM about their activities through the MCP server, and two
kinds of question are still weak:

- **"Hiking near Jesenice".** `find_place` turns a name into coordinates,
  but it does that by sending the name to OpenStreetMap's Nominatim. That
  breaks the v2 rule that the MCP server makes no network calls except to
  its own R2 bucket. The OSM points the refresh already uses can't replace
  it as they are: they have no towns, cities or huts, so Jesenice, Bled and
  Koper aren't in them.
- **Words.** `name_contains` ignores accents in neither direction: "smarna"
  finds 0 activities, "Šmarna" finds 5. It looks only at the name, and 333
  of 547 names are defaults like "Morning Hike". Place and route names, and
  the descriptions, can't be searched at all.

Issue #35 also asks for embeddings. The research note recommended them for a
fuzzy tier of queries. This design checks that recommendation against the
queries the owner actually asks, now that places, same-route groups and geo
search exist, and concludes **not yet** (see [Semantic search](#semantic-search-not-yet)).

## Owner decisions (2026-11-22)

- **Nominatim is dropped,** with no opt-in flag. `find_place` is offline
  only.
- **Descriptions are matched, never shown.** Text search matches the words
  in Strava descriptions, but no tool returns description text, and the
  `query` tool keeps blocking `summary_json`.
- **No site change.** The Activities page keeps its own search
  (`app/src/activitySearch.ts`).

Earlier decisions this design keeps: no network in the daily CI job; OSM
points live in their own file, not in the database (2026-11-21, "roughly
halves each transfer"); huts, lakes, protected areas, settlements, elevation
band and season are not tags (place-tags design).

## Goals

- `find_place` answers from a local file built from the OSM snapshots the
  archive already keeps. Names match with case and accents ignored, and
  alternative names count too ("Lake Bled" finds Blejsko jezero).
- When a name fits many points, the ones near the owner's own activities
  come first. "Vršič" means the pass the owner rode over, not one of the 34
  Slovenian peaks with that name.
- One `text` filter, shared by `list_activities` and `summarize`, matches
  words from the start, with case and accents ignored. It looks in the
  name, type, place name, route name and descriptions.
- `activities_near` says how close the nearest activity came when none is
  inside the radius.
- Example queries pass as tests on a fixture: the existing Slavnik one, and
  "hiking near Jesenice" plus eight more.
- Sizes are measured and written down. The database doesn't grow.

## Non-goals

- **Embeddings, vectors and `sqlite-vec`.** See below for why, and for what
  would change that.
- **"Similar activities"** (numeric features + Fréchet, from the research
  note). It's a separate feature, not search, and needs its own design.
- **Areas:** "hikes in Austria" or "in Triglav National Park" would need
  boundary polygons. Points can't answer "in".
- **Streets, shops and addresses.** Nominatim had them, the gazetteer won't.
- **Tags per activity.** No nearest town at the start, no huts passed.
  "Near X" is answered at query time by geo, as #35 asks.
- **Site changes** (owner).
- **A geo filter in `summarize`** ("km hiked near Jesenice"). See the open
  questions.

## Anti-goals

- **A search text leaving the machine.** This now covers place names too.
- **A database that grows for search.** Every writer, the deploy and the MCP
  server pull the database. The gazetteer goes in its own file, which only
  the MCP server downloads, once per OSM update.
- **Description text in tool output.** A match may say that an activity's
  description has the words, but never what it says.
- **Search that disagrees with itself.** The place filter, the `text` filter
  and `find_place` all fold names with the same function (`fold_name`).

## Measured on the owner's data (2026-11-22)

Read-only, on `data/activities.sqlite` synced from R2 and on the archive's
OSM snapshots, with scratch scripts that aren't committed.

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

### The OSM data

- **Snapshots** in the archive (newest per country, raw Overpass JSON): AT
  10.0 MB, IS 0.9 MB, IT 29.8 MB, NO 28.2 MB, SI 3.9 MB.
- **The refresh's points file** (`derived/osm-points/v1-…sqlite`):
  24,043,520 bytes, 11.3 MB gzipped, 328,165 points.
  - Kinds: peak, pass, park, water, village, hamlet, suburb, quarter and
    neighbourhood.
  - Only `name` is kept. No towns, cities or huts: "Jesenice", "Bled",
    "Koper" and "Bohinj" find nothing. "Ljubljana" finds only a peak.
- **Alternative names are already in the snapshots.** The query keeps every
  tag. In SI, 4,122 of 19,144 points have `name:*`, `alt_name` or
  `official_name`. Blejsko jezero has `name:en` "Lake Bled", Triglav has
  `name:it` "Tricorno", and Slavnik has `alt_name` "Primorski Triglav".
- **What adding kinds would bring,** counted with Overpass `out count`
  (SI / AT):

  | Kind | SI | AT |
  |---|---|---|
  | `place=town\|city` (nodes) | 72 | 229 |
  | `tourism=alpine_hut\|wilderness_hut` | 233 | 1,531 |
  | `place=isolated_dwelling` | 1,424 | 5,335 |
  | `place=locality` | 2,006 | 20,317 |
  | `amenity=shelter` | 151 | 2,546 |
  | `natural=valley\|ridge\|glacier\|cave_entrance` | 1,202 | 7,243 |
  | `waterway=waterfall` | 175 | 337 |
  | `boundary=national_park\|protected_area` | 207 | 1,499 |

- **Coverage of the activities:** of 454 GPS activities, 423 start within
  15 km of a point in a loaded country (SI 384, IS 12, IT 11, AT 8, NO 8).
  31 start in six countries that haven't been downloaded, 25 of them in
  Denmark.
- **"Vršič":** 34 SI peaks are named exactly that (36 points in all). The pass is "Prelaz
  Vršič", which only a whole-word match finds.

### Gazetteer prototype

Built in 14 s from the five snapshots. It holds the existing kinds, every
`name`, `name:sl|en|de|it`, `alt_name` and `official_name` (split on `;`),
and a folded copy of each.

| Layout | Bytes | gzip |
|---|---|---|
| points + folded name + `alt_names` (37,973 rows), no index | 28,082,176 | 13.6 MB |
| the same + B-tree indexes on the folded names | 39,796,736 | 18.5 MB |
| one `names` table (366,132 rows) + FTS5 trigram index | 51,482,624 | 22.3 MB |

Lookup times on the unindexed file, with `mode=ro`:
- a whole-word or word-start scan of all names in SQL: 50–80 ms
- a typo fallback ("slavnk" → slavnik, savnik): `difflib` over the 5,977
  names of similar length and the same first letter, 90 ms

Loading every name into Python instead takes 2.7 s and 67 MB, so that's out.

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

### The target queries on real data, with today's tools

- **"All hikes to Slavnik"**: `list_activities(types=[Hike], place=Slavnik)`
  gives 30.
- **"Hiking near Jesenice"**: once Jesenice has coordinates,
  `activities_near` finds no hike within 1, 3 or 5 km. One ride passes
  473 m from the town, and the nearest hikes come 12.3 km away. An empty
  answer with nothing else in it would leave the LLM guessing. That's why
  `activities_near` gains `nearest`.
- **"Rides over Vršič"**: the place exists (Prelaz Vršič, 1 activity), and
  `activities_near` at 200 m finds the same ride.
- **"Runs from Ljubljana"**: 121 runs start within 3 km of the centre, 131
  within 8 km.

## The offline gazetteer

### Approaches considered

| | Where the gazetteer lives | Cost | Verdict |
|---|---|---|---|
| **A** | Its own derived file, `derived/gazetteer/v1-<hash>.sqlite`, built from the same snapshots as the points file | About 28 MB, downloaded once per OSM update, by the MCP server only. CI never needs it | **Chosen** |
| B | The points file grows to hold it (v2) | One file, but CI downloads every new points file (the perf plan: "22 MB once per machine, which CI pays daily"), and it would grow from 24 to 28–40 MB | No |
| C | A table in the database | Reverses the 2026-11-21 move. Every pull grows by about 28 MB | No |
| D | Geofabrik `.osm.pbf` extracts | Complete and no load on Overpass, but hundreds of MB per country and a new native dependency (osmium). The archive already keeps Overpass snapshots, and a rebuild already works offline | No |

### What goes in

- **Kinds:**
  - everything the points file has: peak, pass, park, water and the five
    place kinds
  - **town and city**: `place=town|city` nodes, kind `town` or `city`
  - **huts**: `tourism=alpine_hut|wilderness_hut`, kind `hut`

  Without towns, the main target query fails. Huts are what hikers name
  ("Dom na Komni", "Koča na Golici") and cost little (233 in SI). Huts
  stay out of tags and the Places list. They are only something to look
  up.
- **Left out:**
  - localities and isolated dwellings: 3,430 in SI, 25,652 in AT, mostly
    names nobody searches for
  - shelters, valleys, ridges, waterfalls and protected areas
  - Protected areas would need polygons to answer "in", which is a
    non-goal.

  Adding any of these later is one line in the Overpass query and a new
  `places:update`.
- **Names:**
  - `name`, plus `name:sl`, `name:en`, `name:de`, `name:it`, `alt_name`
    and `official_name`
  - values split on `;`
  - a variant whose folded form equals the main name's isn't stored

  The languages are Slovenian, English and the neighbours' (my call).
  Other scripts (Cyrillic, Korean) add rows nobody types.
- **Countries:** the ones `places:update` has fetched: SI, AT, IT, NO and
  IS today. Adding DK and the other five countries would cover the
  remaining 31 activities. That's the owner's call when running
  `places:update` (see the open questions).

### The Overpass query

`overpass_query` gains two statements:

```
  node["place"~"^(town|city)$"]["name"](area.a);
  nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"](area.a);
```

`parse_points` for the refresh's points file keeps mapping only the kinds it
maps today. `_kind` returns None for a town or a hut, so those are dropped.
The places and route names the refresh computes don't depend on the new
kinds, and only new OSM data can change them, as with any `places:update`.

### The file

```sql
CREATE TABLE points (
  osm_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, folded TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, ele REAL, country TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE alt_names (osm_id TEXT NOT NULL, name TEXT NOT NULL, folded TEXT NOT NULL);
CREATE TABLE snapshots (country TEXT PRIMARY KEY, key TEXT NOT NULL);  -- what it was built from
PRAGMA user_version = 1;
```

- **`folded`** is `fold_name` (the one in `mcp_server/filters.py`, moved to
  a leaf module so `ingest` can use it), plus punctuation turned into
  spaces and runs of spaces collapsed. So "Kranjska-Gora" and "Kranjska
  Gora" match.
- **No indexes.** Every lookup is one scan, 50–80 ms. Indexes would add
  12 MB for under 1 ms saved.
- **Border features** that two countries return are kept once, under the
  later country in sorted order, as the points file does.
- **Deterministic:** the same snapshots give the same bytes (countries in
  sorted order, rows in sorted order, `VACUUM` at the end). A test checks
  this.
- **Named** `v1-<hash>.sqlite`, with the same hash as the points file
  (`osm.points_file_name` over the newest snapshot keys), under
  `derived/gazetteer/`. `put_derived` already deletes the folder's other
  keys, so R2 holds one file.

### Who builds it

- **`places:update`** builds and stores it right after it stores the new
  snapshots, next to the points file. Writers in CI never do. If the file
  is missing, the MCP server says so and names the command.
- **`pnpm run places:update -- --files-only`** builds both files from the
  stored snapshots without fetching. It's for a machine whose snapshots
  are already current. (The flag is my call; without it, the first
  rollout would need a refetch anyway, for the new kinds.)

### How the MCP server gets it

- **With R2:**
  - The server lists `osm/` with the read-only token (checked: `R2_RO_*`
    can list `osm/` and `derived/`). It works out the file name the way
    writers do, and downloads `derived/gazetteer/<name>` into
    `<db folder>/cache/<bucket>/derived/gazetteer/`.
  - This runs on the sync thread, after the database check and on the same
    hourly schedule, so no tool waits for it. A `RemoteArchive` with the
    read-only store and that cache root does the work: `get_derived` never
    writes to the store.
  - The database download stays first, so the larger file never holds it
    up.
- **Without R2,** in a fork that uses the local archive: the server reads
  `<db folder>/archive/derived/gazetteer/`. `--gazetteer PATH` overrides
  either, and is used in tests.
- **`--no-sync`:** the cached file as it is. No listing, no download.
- **Until a file is in,** `find_place` returns a tool error in the
  `notice` style:
  - "The offline place list is downloading from R2 (12 of 28 MB); try
    again in a minute"
  - "There's no offline place list in R2 yet: run `pnpm run places:update
    SI AT …` on a machine with R2 write access"

  Every other tool works as before.
- **Old files:** a newer gazetteer replaces the cached one, and the server
  deletes the older files in its own cache folder only.
- **`as_of`** gains `gazetteer`: the countries and the newest snapshot date,
  e.g. `{"countries": ["AT","IS","IT","NO","SI"], "snapshots_through": "2026-11-13"}`,
  or the download status.

### Matching and ranking

`find_place(query)`:

1. **Fold the query** with the same function.
2. **Match** in one SQL scan over `points.folded` and `alt_names.folded`.
   The match classes, best first:
   - **exact**: the folded name equals the query
   - **alternative**: an alternative name equals it
   - **words**: the query is a run of whole words in a name. "vrsic"
     finds "Prelaz Vršič".
   - **starts**: a word in a name starts with the query. "smarna" finds
     "Šmarna gora".
3. **Typo fallback,** only when step 2 finds nothing: `difflib` ratio
   ≥ 0.8, over names within 2 characters of the query's length that start
   with the same letter. Its class is **similar**.
4. **Rank** by:
   - whether any visible activity's bounding box, widened by 2 km, holds
     the point (yes first)
   - the match class
   - the number of such activities (more first)
   - kind: city, town, village, suburb, peak, pass, hut, water, quarter,
     hamlet, neighbourhood, park
   - `osm_id`

   Activity proximity comes first because the point of `find_place` is
   to find the owner's activities next. The bounding-box count is cheap
   (SQL over `min_lat`…`max_lng`) and is only a ranking signal.
   `activities_near` gives the exact answer.
5. **Return** the top 5, and `total_matches`.

Each candidate has:
- `name`, `matched_name` (when an alternative or similar name matched),
  `match`, `kind`
- `lat`, `lon`, `elevation_m`, `country`, `osm_id`
- `activities_nearby` (the bounding-box count)
- `suggested_radius_m` for `activities_near`

`counted` gets these rules:
- "offline OpenStreetMap place list: AT IS IT NO SI, snapshots through
  2026-11-13"
- "names compared with case and accents ignored"
- "ranked: near your activities first, then match"

`included` is the number of candidates returned, and `excluded` has "more
matches not shown".

**No match:** an empty list. The rules name the loaded countries, so the
LLM can say "Odense isn't in the offline place list (loaded: AT IS IT NO
SI)". It can then use coordinates it's sure of, or suggest `places:update
DK`.

**Suggested radius** per kind (my call; the LLM sees it and may pick
another, and the radius used shows in `activities_near`'s rules):

| Kind | Suggested radius |
|---|---|
| city | 5 km |
| town | 3 km |
| village, suburb | 1.5 km |
| quarter, hamlet | 1 km |
| neighbourhood | 800 m |
| water (its centre) | 500 m |
| park | 300 m |
| peak, pass | 200 m |
| hut | 150 m |

The peak radius is the default 200 m from the MCP design. For a lake, a
walk around Lake Bled stays about 500 m from its centre.

### `activities_near` when nothing is inside

When `total` is 0, the result gains `nearest`: the activity of the same
filter whose route came closest, searched out to `MAX_RADIUS_M` (50 km),
as `{id, date_local, type, name, closest_m}`, or null. The counted rule
says "nearest outside the radius: 12.3 km". On real data this turns
"hiking near Jesenice" into "no hikes within 3 km; the closest came
12.3 km away" instead of a bare zero. It costs a second candidate pass
with a wider box, and only when the first finds nothing.

### What changes for the owner

- `find_place` loses its `open_world` annotation, its User-Agent and its
  1-per-second wait. The `data/mcp/places.json` cache is no longer read.
  The server deletes it on start (my call: it holds only past search
  texts).
- **README:** "Only the conversation and any place names you search for
  (sent to OpenStreetMap's Nominatim) leave your machine" becomes "Only
  the conversation leaves your machine. Place names are looked up in an
  offline list built from OpenStreetMap by `places:update`."
- **`guide.md`, "Which tool":** the `find_place` line says it's offline,
  that it covers peaks, passes, huts, lakes, parks and settlements from
  village to city in the loaded countries, that it ranks places near the
  owner's activities first, and that `suggested_radius_m` is the radius
  to start from. Streets and shops aren't in it.

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
- **Location is geo, not vectors** (#35). The gazetteer and
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

They run on the MCP fixture (`ingest/tests/mcp_fixture.py`, extended)
with a fixture gazetteer built from a hand-written Overpass response. Each
test calls the tool functions the way an LLM would, and checks the
activity ids. One test file, `ingest/tests/test_mcp_queries.py`, with the
query as each test's docstring.

| # | Query | Tool calls | Expected |
|---|---|---|---|
| 1 | All hikes to Slavnik | `list_activities(types=[Hike], place="slavnik")` | the two Slavnik hikes (exists today; moves into the file) |
| 2 | Hiking near Jesenice | `find_place("Jesenice")` → the town first, `suggested_radius_m` 3000 → `activities_near(…, 3000, types=[Hike])` | the hike up from Jesenice; not the walk in town; not the Slavnik hikes |
| 3 | Hiking near Jesenice, none close | the same on a fixture with no hike inside 3 km | `total` 0, `nearest` is the hike 12 km away |
| 4 | Rides over Vršič | `find_place("Vršič")` → "Prelaz Vršič" first (a fixture ride passes it), ahead of an exact-name peak "Vršič" with no activity nearby → `activities_near(…, 200, types=[Ride])` | the Vršič ride |
| 5 | Walks around Lake Bled | `find_place("lake bled")` → Blejsko jezero, `match` "alternative", `matched_name` "Lake Bled" → `activities_near(…, 500, types=[Walk])` | the lake walk |
| 6 | Runs from Ljubljana | `find_place("ljubljana")` → the city, not the peak of the same name → `activities_near(…, 5000, mode="start", types=[Run])` | the two runs that start there |
| 7 | Šmarna gora, typed without accents | `list_activities(text="smarna gora")`, and `name_contains="smarna"` | the activities named or placed at Šmarna gora |
| 8 | Cold rainy walks | `list_activities(types=[Walk], text="cold rain")` | the walk whose description says "Rain, Cold". Not a WeightTraining. The row has no description |
| 9 | Hikes over 1,000 m of climbing in a given year | `list_activities(types=[Hike], min_gain_m=1000, date_from=…, date_to=…)` | the one big hike; a hike with unknown gain doesn't pass |
| 10 | A place in a country not loaded | `find_place("Odense")` | no candidates; the rules name the loaded countries |
| 11 | A typo | `find_place("slavnk")` | Slavnik, `match` "similar" |

## Sizes and budget

- **The database: no change** (45.6 MB today). The text table is TEMP, on
  the server's connection, and never written to the file.
- **The gazetteer file:** about 28 MB (13.6 MB gzipped) from today's
  snapshots plus the new kinds. That's a few thousand towns and huts on
  top of 328k points, well under 1 MB, to be measured after the refetch.
  The MCP server downloads it once per `places:update`. CI, the deploy
  and the site never do.
- **The refresh's points file:** unchanged in shape, about 24 MB. It gets
  a new name once, because the refetch makes new snapshots.
- **Snapshots in the archive:** slightly larger, from the two new
  statements.
- **Vectors:** none.

Plan 2 ends with these measured again on the owner's data and written into
this section, as the place-tags design did.

## Left to the builder

- Function and module names.
- Where `fold_name` moves (a leaf module that `ingest.gazetteer` and
  `mcp_server.filters` both import).
- Whether the gazetteer download reports progress the way the database
  download does. It should, if `get_derived` can stream.
- The exact `difflib` cutoff, if 0.8 lets in noise on the fixture.

## Calls I made (check these)

- Towns, cities and huts go into the gazetteer. Localities, isolated
  dwellings, shelters, valleys, waterfalls and protected areas don't.
- Alternative names in Slovenian, English, German and Italian, plus
  `alt_name` and `official_name`.
- The gazetteer is its own derived file, not part of the points file or
  the database.
- Ranking puts places near the owner's activities first.
- The suggested radii above.
- `activities_near` returns `nearest` when nothing is inside the radius.
- Text matches from the start of a word, not anywhere in it. This differs
  from the site's search, which matches anywhere (see the open questions).
- `min_gain_m`/`max_gain_m` added.
- No new search tool.
- `data/mcp/places.json` is deleted on start.
- `places:update --files-only`.

## Open questions for the owner

- **More countries:** run `places:update` with DK (25 activities) and the
  five countries with one or two activities each? Each is one more
  Overpass request and a few MB of snapshot.
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
