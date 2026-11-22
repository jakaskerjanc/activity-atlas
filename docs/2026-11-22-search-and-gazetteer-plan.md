# Search and Gazetteer Plan: Text Search, "Nearest" and the Example Queries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- `list_activities` and `summarize` take a `text` filter. It matches each word from the start of a word in the name, type, place, route and Strava descriptions, with case and accents ignored.
- `name_contains` ignores accents.
- `activities_near` says how close the nearest activity came when none is inside the radius.
- "All hikes to Slavnik", "hiking near Jesenice" and six more example queries pass as tests.
- No tool ever returns description text, and the database file doesn't change.

**Architecture:**
- **Text.** When `Database` opens or reopens the file, it builds a TEMP table `activity_text(id, folded)` on its own connection (`conn`), and registers two deterministic SQL functions there: `fold` and `words_match`. `where_sql` stays pure: for `text`, it emits `a.id IN (SELECT id FROM temp.activity_text WHERE words_match(folded, ?))`. The raw `query` tool uses the other connection (`query_conn`), which has neither the table nor the functions, so descriptions stay unreadable there.
- **Nearest.** `geo.activities_near` runs its candidate pass a second time, with the 50 km maximum, only when the first finds nothing.
- **`find_place` is unchanged.** No offline gazetteer, no re-ranking, no schema change (owner, 2026-11-22).

**Tech Stack:** Python 3.12 standard library (`sqlite3`, `json`), the existing `ingest.mcp_server` modules (`filters.fold_name`) and MCP SDK, pytest.

**Spec:** `docs/2026-11-22-search-and-gazetteer-design.md`.

## Global Constraints

- No new dependencies, no schema change, and nothing is written to the database file. No network in tests: Nominatim is mocked, as today.
- **A search text** is the activity's:
  - `name`
  - `type`
  - `type` split into words at lower→upper case changes (`WeightTraining` → `Weight Training`)
  - place name and route name, when `activity_groups` exists
  - every non-empty `json_extract(summary_json, '$."Activity Description"')` of its `activity_sources` rows with `provider = 'strava' AND deleted_at IS NULL`, in `provider_activity_id` order

  The parts are joined with `"\n"` and folded with `filters.fold_name`.
- **Matching:** the query is folded with `fold_name` and split on whitespace into words. An activity matches when every word occurs in its search text at a word start: position 0, or after a character that is neither a letter nor a digit (`not ch.isalnum()`). A query with no words is the same as no `text` filter.
- **`counted.rules` text for `text`,** copied verbatim: `text: "{query}" (each word from the start of a word, case and accents ignored; name, type, place, route or description)`.
- **`name_contains`** becomes `instr(fold(a.name), ?) > 0`, with the parameter `fold_name(value)`. Its rule text stays `name contains {value!r}`.
- **Descriptions:** never in a tool result, not in any row, and not in `get_activity`. `query` still returns `summary_json` as NULL, and can't read `temp.activity_text`: a query that names it fails.
- **`nearest` in `activities_near`:** every result has `data["nearest"]`.
  - It's `None` when `total > 0`.
  - Otherwise it's the activity of the same filter and mode with the smallest closest distance within `MAX_RADIUS_M`, as `{id, date_local, type, name, closest_m}`, or `None` when there's none.
  - When it's set, the rule `nearest outside the radius: {closest_m / 1000:.1f} km` is added.
- **Python command:** `$PY` is the main checkout's venv Python. No absolute home paths in committed files.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A database written before places existed** (no `activity_groups`, `places` or `route_groups`) → the text table builds from name, type and descriptions only, and `text` works. Test in Task 1.
2. **`summary_json` that is NULL, not JSON, or has no description key** (Garmin rows, deleted Strava rows) → it adds nothing and raises nothing. Test in Task 1.
3. **A query with quotes, `%`, `_`, or SQL in it** (`text="o'clock"`, `"100%"`) → matched as plain words, never as a pattern or as SQL. Test in Task 1.
4. **A sync replaces the file while the server runs** → the reopen rebuilds the TEMP table from the new file, and a newly named activity is found by the next call. Test in Task 1.
5. **The `query` tool asked for the TEMP table, or for `words_match()`** → a `QueryError`, and no description text reaches the result. Test in Task 1.
6. **`activities_near` with mode `start` or `end` and nothing inside** → `nearest` uses the same mode's distance, not the closest point of the route. Test in Task 2.

---

## File Structure

```
ingest/mcp_server/textsearch.py   # search_texts(conn), words_match(folded, words_json), split_type
ingest/mcp_server/database.py     # _open builds temp.activity_text and registers fold/words_match on conn
ingest/mcp_server/filters.py      # ActivityFilter.text; name_contains folds
ingest/mcp_server/server.py       # text on list_activities and summarize
ingest/mcp_server/geo.py          # nearest when nothing is inside
ingest/mcp_server/guide.md
ingest/tests/mcp_fixture.py       # descriptions on Strava sources; a WeightTraining
ingest/tests/place_fixture.py     # activities around real places + Nominatim mock bodies
ingest/tests/test_mcp_textsearch.py, test_mcp_activities.py, test_mcp_geo.py, test_mcp_queries.py
docs/2026-11-22-search-and-gazetteer-design.md   # sizes measured
```

---

### Task 1: The `text` filter

**Files:**
- Create: `ingest/mcp_server/textsearch.py`, `ingest/tests/test_mcp_textsearch.py`
- Modify:
  - `ingest/mcp_server/database.py` (`_open`)
  - `ingest/mcp_server/filters.py` (`ActivityFilter`, `where_sql`)
  - `ingest/mcp_server/server.py` (`_filter`, the `list_activities` and `summarize` signatures and docstrings)
  - `ingest/mcp_server/guide.md`
  - `ingest/tests/mcp_fixture.py`, adding:
    - a Strava source for `walk1` with `summary_json` `{"Activity Description": "Weather: 3°C, Rain, Cold"}`
    - a Garmin source with `summary_json` NULL
    - a deleted Strava source for `run2` whose description says "Slavnik"
    - `wt1`, a WeightTraining
- Test: `ingest/tests/test_mcp_textsearch.py`, `ingest/tests/test_mcp_activities.py`, `ingest/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `filters.fold_name`, `filters.has_group_tables`.
- Produces:
  - `textsearch.split_type(t: str) -> str`: `"WeightTraining"` → `"Weight Training"`.
  - `textsearch.search_texts(conn) -> dict[str, str]`: id → folded search text for every activity, hidden ones included.
  - `textsearch.words_match(folded: str, words_json: str) -> int`: 1 when every word of `json.loads(words_json)` occurs at a word start, else 0. The words come pre-folded.
  - `Database._open` does this on `conn` only:
    - registers `fold` (`fold_name`) and `words_match`, both `deterministic=True`
    - creates `temp.activity_text(id TEXT PRIMARY KEY, folded TEXT NOT NULL) WITHOUT ROWID` and fills it from `search_texts`

    A reopen rebuilds it.
  - `ActivityFilter.text: str | None = None`. In `where_sql`, it adds `a.id IN (SELECT id FROM temp.activity_text WHERE words_match(folded, ?))`, with the parameter `json.dumps(fold_name(text).split())`, and the rule from the Global Constraints.
  - The server's `list_activities` and `summarize` take `text`, documented as "words to find, each from the start of a word (case and accents ignored), in the name, type, place, route or description".
  - `guide.md`:
    - the "Finding activities" line lists `text`
    - "Definitions" gets: "`text` matches every word at the start of a word, ignoring case and accents, in the name, type, place name, route name and Strava description. Descriptions are searched but never returned."
    - the `find_place` line in "Which tool" adds: "for a summit or pass the owner reached, use `places` and the place filter first, or `text` to find a place by part of its name; Nominatim may not list it ("Vršič" returns ten peaks and not the pass)"

- [ ] **Step 1: Write the failing tests**

```python
# test_mcp_textsearch.py
def test_text_has_name_type_place_route_and_description(db):
    t = search_texts(db.conn)
    assert "slavnik out-and-back" in t["slavnik1"]          # route name
    assert "smarna gora" in t["smarna1"]
    assert "rain" in t["walk1"] and "weight training" in t["wt1"]
    assert "slavnik" not in t["run2"]                       # a deleted source's description is ignored

def test_words_match_from_word_starts():
    assert words_match("weighttraining\nweight training", '["rain"]') == 0
    assert words_match("weather: 3°c, rain, cold", '["cold", "rain"]') == 1
    assert words_match("novo brdo loop", '["brdo"]') == 1 and words_match("novobrdo", '["brdo"]') == 0

def test_v4_database_without_group_tables(tmp_path): ...     # drop the three tables → search_texts works, no place names
def test_bad_summary_json_is_skipped(tmp_path): ...          # 'not json' and '{}' → no error
def test_reopen_rebuilds(tmp_path): ...                      # rename an activity in a copy, install it, reopen → new name found
def test_query_tool_cannot_read_the_text_table(db):
    with pytest.raises(QueryError): run_query(db, "SELECT * FROM temp.activity_text")
    with pytest.raises(QueryError): run_query(db, "SELECT words_match('a', '[]')")

# test_mcp_activities.py
def test_text_filter_from_word_starts(db):
    assert ids_of(list_activities(db, ActivityFilter(text="cold rain"))) == ["walk1"]   # not wt1
    r = list_activities(db, ActivityFilter(text="SMARNA"))
    assert ids_of(r) == ["smarna1"]
    assert 'text: "SMARNA" (each word from the start of a word, case and accents ignored; name, type, place, route or description)' \
        in r["counted"]["rules"]

def test_description_never_in_rows(db):
    row = list_activities(db, ActivityFilter(text="rain"))["data"]["rows"][0]
    assert "description" not in row and "Rain" not in json.dumps(row)
    assert "Rain" not in json.dumps(get_activity(db, "walk1"))

@pytest.mark.parametrize("q", ["o'clock", "100%", "a_b", "'; DROP TABLE activities; --"])
def test_text_is_never_a_pattern(db, q): assert list_activities(db, ActivityFilter(text=q))["data"]["total"] == 0
def test_blank_text_is_no_filter(db): ...
def test_text_with_place_and_types(db):
    assert ids_of(list_activities(db, ActivityFilter(types=["Hike"], text="out-and-back"))) == ["slavnik2", "slavnik1"]
def test_summarize_takes_text(db): ...
def test_name_contains_ignores_accents(db):
    assert ids_of(list_activities(db, ActivityFilter(name_contains="smarna"))) == ["smarna1"]

# test_mcp_server.py
def test_list_activities_takes_text(ctx): ...
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_textsearch.py ingest/tests/test_mcp_database.py ingest/tests/test_mcp_activities.py ingest/tests/test_mcp_server.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces above. In `words_match`, find each word with `str.find` in a loop and accept the first hit at a word start. Don't use a regex built from the words.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS. Fixture counts that changed with `wt1` are updated in the tests that pin them.
- [ ] **Step 5: Commit** `feat: text filter over names, places, routes and descriptions; name_contains ignores accents`

---

### Task 2: `activities_near` reports the nearest when nothing is inside

**Files:**
- Create: `ingest/tests/place_fixture.py`
- Modify: `ingest/mcp_server/geo.py` (`activities_near`), `ingest/mcp_server/guide.md`
- Test: `ingest/tests/test_mcp_geo.py`

**Interfaces:**
- Consumes: `mcp_fixture._insert_activity`.
- Produces:
  - `data["nearest"]` and the rule, as in the Global Constraints. The candidate pass moves into `_hits(db, lat, lon, radius_m, mode, where, params) -> list[dict]`. `activities_near` calls it again with `MAX_RADIUS_M` only when the first call returns nothing.
  - `place_fixture.add_place_activities(conn) -> None`, which inserts, with `mcp_fixture._insert_activity` and synthetic tracks (all visible, gain NULL):
    - `jes_hike` (2025-06-01): a Hike that starts 800 m from Jesenice town (46.432, 14.062) and climbs north
    - `jes_walk`: a Walk in town
    - `far_hike` (2025-05-01): a Hike whose closest point is 12 km from the town
    - `bled_walk`: a Walk 400–600 m from Blejsko jezero's centre (46.364, 14.094)
    - `lj_run1`, `lj_run2`: Runs that start within 2 km of Ljubljana (46.050, 14.507)
    - `vrsic_ride`: a Ride over Prelaz Vršič (46.435, 13.744), with place `vrsic1` "Prelaz Vršič" (kind pass) in `places` and `activity_groups`
  - A `pdb` fixture in `test_mcp_geo.py`: the MCP fixture plus `add_place_activities`.
  - `guide.md` "Definitions" gains: "When nothing is inside the radius, `activities_near` gives `nearest`: the closest activity of the same filter within 50 km. Say how far it was rather than just 'none'."

- [ ] **Step 1: Write the failing tests**

```python
def test_nothing_inside_reports_nearest(pdb):
    r = activities_near(pdb, 46.432, 14.062, 3000, "route", ActivityFilter(types=["Hike"], date_to="2025-05-31"))
    assert r["data"]["total"] == 0 and r["data"]["nearest"]["id"] == "far_hike"
    assert 11500 < r["data"]["nearest"]["closest_m"] < 12500
    assert any(x.startswith("nearest outside the radius: 1") for x in r["counted"]["rules"])
def test_nearest_is_none_when_something_is_inside(pdb): ...
def test_nearest_none_beyond_50_km(pdb): ...                  # a point far from every track
def test_nearest_uses_the_mode(pdb): ...                      # mode="start": nearest by start point, not route
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_geo.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces above.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: activities_near says how close the nearest activity came`

---

### Task 3: The example queries, and the sizes written down

**Files:**
- Create: `ingest/tests/test_mcp_queries.py`
- Modify:
  - `ingest/tests/place_fixture.py`
  - `ingest/tests/test_mcp_activities.py`: the Slavnik name case moves out
  - `docs/2026-11-22-search-and-gazetteer-design.md`

**Interfaces:**
- Consumes: the tools through `build_server(ctx).call_tool`, as an LLM calls them.
- Produces in `place_fixture.py`:
  - `NOMINATIM: dict[str, list[dict]]`: mock bodies for "jesenice", "lake bled" and "ljubljana", in the field shape and order Nominatim returned on 2026-11-22 (`name`, `display_name`, `category`, `type`, `addresstype`, `lat`, `lon`, `boundingbox` as strings, `extratags`), cut to today's limit of 5. For "jesenice" that's the SI municipality, the SI town, then three Czech places.
  - `fetch(url, params) -> list[dict]`, a stub that serves `NOMINATIM[params["q"].lower()]`, records calls, and returns `[]` for other names.
- A `qctx` fixture in `test_mcp_queries.py` builds the MCP fixture, calls `add_place_activities`, and wires `PlaceFinder(..., fetch=place_fixture.fetch)`. `test_mcp_server.py`'s `ctx` is left alone, so its pinned counts don't move.

- [ ] **Step 1: Write the tests,** one per query in the design's table, with the query as the docstring. Where a query needs a radius, the test picks it, as an LLM would.
  1. "All hikes to Slavnik": `list_activities(types=["Hike"], place="slavnik")` → `["slavnik2", "slavnik1"]`. This moves `test_place_filter_by_id_and_name`'s name case here; the id case stays.
  2. "Hiking near Jesenice": `find_place("Jesenice")` → the second candidate is the SI `place/town` → `activities_near(..., 3000, types=["Hike"])` → `["jes_hike"]`.
  3. "Hiking near Jesenice, none close": the same with `date_to="2025-05-31"` → `total` 0, `nearest.id == "far_hike"`.
  4. "Walks around Lake Bled": `find_place("Lake Bled")` → Blejsko jezero → `activities_near(..., 700, types=["Walk"])` → `["bled_walk"]`.
  5. "Runs from Ljubljana": `find_place("Ljubljana")` → the city → `activities_near(..., 5000, mode="start", types=["Run"])` → `["lj_run1", "lj_run2"]`, in `closest_m` order.
  6. "Rides over Vršič": `list_activities(types=["Ride"], text="vršič")` → `["vrsic_ride"]`, found through its place name "Prelaz Vršič". The place filter wants the whole name, and Nominatim doesn't list the pass.
  7. "Šmarna gora, typed without accents": `text="smarna gora"` → `["smarna1"]`, and `name_contains="smarna"` → `["smarna1"]`.
  8. "Cold rainy walks": `types=["Walk"], text="cold rain"` → `["walk1"]`. The row has no description.
- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_queries.py -q`. Expected: PASS. They pin the chain; a failure is a bug in Tasks 1–2.
- [ ] **Step 3: Measure on the owner's data,** read-only, after syncing a fresh copy:
  - the database's size, which must be unchanged by this plan
  - the time to build `activity_text` (expect about 20 ms)
  - the time for a two-word `list_activities(text=…)` call
  - the hits for "rain" (expect 20) and "cold" (54) as words

  Write them into "Sizes and budget" in the design doc, next to the database size. In "Done when" on issue #35, the owner can then tick "The tag, gazetteer and vector tables fit in the database budget" with these figures: no gazetteer, no vectors, and nothing added to the database.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q && pnpm run test:all`. Expected: PASS.
- [ ] **Step 5: Commit** `test: example queries for #35; docs: search sizes measured`
