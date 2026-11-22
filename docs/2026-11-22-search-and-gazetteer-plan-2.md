# Search and Gazetteer, Plan 2: Text Search and the Remaining Example Queries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `list_activities` and `summarize` take a `text` filter that matches whole words in the name, type, place, route and Strava descriptions, with case and accents ignored. They also take `min_gain_m`/`max_gain_m`. `name_contains` ignores accents. No tool ever returns description text, and the database file doesn't change.

**Architecture:** When `Database` opens or reopens the file, it builds a TEMP table `activity_text(id, folded)` on its own connection (`conn`) and registers two deterministic SQL functions there: `fold` and `words_match`. `where_sql` stays pure: for `text`, it emits `a.id IN (SELECT id FROM temp.activity_text WHERE words_match(folded, ?))`. The raw `query` tool uses the other connection (`query_conn`), which has neither the table nor the functions, so descriptions stay unreadable there.

**Tech Stack:** Python 3.12 standard library (`sqlite3`, `json`, `re`), the existing `ingest.mcp_server` modules (`filters.fold_name`), pytest.

**Spec:** `docs/2026-11-22-search-and-gazetteer-design.md`. Independent of plan 1. Whichever plan runs second adds to `ingest/tests/test_mcp_queries.py` and `ingest/tests/place_fixture.py`; if this one runs first, it creates both, with only what its queries need (the `qctx` fixture and `vrsic_ride` with its place `vrsic1` "Prelaz Vršič", as plan 1's Task 1 describes them).

## Global Constraints

- No new dependencies. No schema change, and nothing is written to the database file.
- **A search text** is the activity's:
  - `name`
  - `type`
  - `type` split into words at lower→upper case changes (`WeightTraining` → `Weight Training`)
  - place name and route name, when `activity_groups` exists
  - every non-empty `json_extract(summary_json, '$."Activity Description"')` of its `activity_sources` rows with `provider = 'strava' AND deleted_at IS NULL`, in `provider_activity_id` order

  The parts are joined with `"\n"` and folded with `filters.fold_name`.
- **Matching:** the query is folded with `fold_name` and split on whitespace into words. An activity matches when every word occurs in its search text at a word start: position 0, or after a character that is neither a letter nor a digit (`not ch.isalnum()`). A query with no words is the same as no `text` filter.
- **`counted.rules` text,** copied verbatim: `text: "{query}" (whole words, case and accents ignored; name, type, place, route or description)`.
- **`name_contains`** becomes `instr(fold(a.name), ?) > 0`, with the parameter `fold_name(value)`. Its rule text stays `name contains {value!r}`.
- **`min_gain_m` / `max_gain_m`:**
  - SQL: `a.elevation_gain >= ?` / `<= ?`
  - rules: `elevation gain >= {n} m` / `elevation gain <= {n} m`, with `{n}` formatted by `_num`
  - a NULL gain fails both
- **Descriptions:** never in a tool result, not in any row, and not in `get_activity`. `query` still returns `summary_json` as NULL, and can't read `temp.activity_text`: a query that names it fails.
- **Python command:** `$PY` as in plan 1. **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A database written before places existed** (no `activity_groups`, `places` or `route_groups`) → the text table builds from name, type and descriptions only, and `text` works. Test in Task 1.
2. **`summary_json` that is NULL, not JSON, or has no description key** (Garmin rows, deleted Strava rows) → it adds nothing and raises nothing. Test in Task 1.
3. **A query with quotes, `%`, `_`, or SQL in it** (`text="o'clock"`, `"100%"`) → matched as plain words, never as a pattern or as SQL. Test in Task 2.
4. **A sync replaces the file while the server runs** → the reopen rebuilds the TEMP table from the new file, and a newly named activity is found by the next call. Test in Task 1.
5. **The `query` tool asked for the TEMP table, or for `words_match()`** → a `QueryError`, and no description text reaches the result. Test in Task 1.

---

## File Structure

```
ingest/mcp_server/textsearch.py   # search_texts(conn), words_match(folded, words_json), split_type
ingest/mcp_server/database.py     # _open builds temp.activity_text and registers fold/words_match on conn
ingest/mcp_server/filters.py      # ActivityFilter.text, min_gain_m, max_gain_m; name_contains folds
ingest/mcp_server/server.py       # the new parameters on list_activities and summarize
ingest/mcp_server/guide.md
ingest/tests/mcp_fixture.py       # descriptions on Strava sources; a WeightTraining; gains
ingest/tests/test_mcp_textsearch.py, test_mcp_activities.py, test_mcp_queries.py
docs/2026-11-22-search-and-gazetteer-design.md   # sizes measured
```

---

### Task 1: The search text table

**Files:**
- Create: `ingest/mcp_server/textsearch.py`, `ingest/tests/test_mcp_textsearch.py`
- Modify:
  - `ingest/mcp_server/database.py` (`_open`)
  - `ingest/tests/mcp_fixture.py`, adding:
    - a Strava source for `walk1` with `summary_json` `{"Activity Description": "Weather: 3°C, Rain, Cold"}`
    - a Garmin source with `summary_json` NULL
    - a deleted Strava source for `run2` whose description says "Slavnik"
    - `wt1`, a WeightTraining

**Interfaces:**
- Consumes: `filters.fold_name`, `filters.has_group_tables`.
- Produces:
  - `textsearch.split_type(t: str) -> str`: `"WeightTraining"` → `"Weight Training"`.
  - `textsearch.search_texts(conn) -> dict[str, str]`: id → folded search text for every activity, hidden ones included.
  - `textsearch.words_match(folded: str, words_json: str) -> int`: 1 when every word of `json.loads(words_json)` occurs at a word start, else 0. The words come pre-folded.
  - `Database._open` does this on `conn` only:
    - registers `fold` (`fold_name`) and `words_match`, both `deterministic=True`
    - creates `temp.activity_text(id TEXT PRIMARY KEY, folded TEXT NOT NULL) WITHOUT ROWID` and fills it from `search_texts`
  - A reopen rebuilds it.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_textsearch.py ingest/tests/test_mcp_database.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `words_match`, find each word with `str.find` in a loop and accept the first hit at a word start. Don't use a regex built from the words.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS. Fixture counts that changed with `wt1` are updated in the tests that pin them.
- [ ] **Step 5: Commit** `feat: MCP server builds a folded search text per activity when it opens the database`

---

### Task 2: The `text`, `min_gain_m` and `max_gain_m` filters

**Files:**
- Modify: `ingest/mcp_server/filters.py` (`ActivityFilter`, `where_sql`), `ingest/mcp_server/server.py` (`_filter`, `list_activities`, `summarize` signatures and docstrings), `ingest/mcp_server/guide.md`
- Test: `ingest/tests/test_mcp_activities.py`, `ingest/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `temp.activity_text` and `words_match` from Task 1.
- Produces:
  - `ActivityFilter.text: str | None = None`, `min_gain_m: float | None = None`, `max_gain_m: float | None = None`
  - in `where_sql`:
    - `text` adds `a.id IN (SELECT id FROM temp.activity_text WHERE words_match(folded, ?))`, with the parameter `json.dumps(fold_name(text).split())`, and the rule from the Global Constraints
    - the gain bounds are added after `max_distance_m`
  - the server's `list_activities` and `summarize` take `text`, `min_gain_m` and `max_gain_m`
  - docstrings:
    - `text`: "words to find (whole words, case and accents ignored) in the name, type, place, route or description"
    - gain: "elevation gain bounds in m"
  - the guide's "Finding activities" line lists `text` and gain. "Definitions" gets: "`text` matches every word at the start of a word, ignoring case and accents, in the name, type, place name, route name and Strava description. Descriptions are searched but never returned."

- [ ] **Step 1: Write the failing tests**

```python
def test_text_filter_whole_words(db):
    assert ids_of(list_activities(db, ActivityFilter(text="cold rain"))) == ["walk1"]   # not wt1
    r = list_activities(db, ActivityFilter(text="SMARNA"))
    assert ids_of(r) == ["smarna1"]
    assert 'text: "SMARNA" (whole words, case and accents ignored; name, type, place, route or description)' \
        in r["counted"]["rules"]

def test_description_never_in_rows(db):
    row = list_activities(db, ActivityFilter(text="rain"))["data"]["rows"][0]
    assert "description" not in row and "Rain" not in json.dumps(row)
    assert "Rain" not in json.dumps(get_activity(db, "walk1"))

@pytest.mark.parametrize("q", ["o'clock", "100%", "a_b", "'; DROP TABLE activities; --"])
def test_text_is_never_a_pattern(db, q): assert list_activities(db, ActivityFilter(text=q))["data"]["total"] == 0
def test_blank_text_is_no_filter(db): ...
def test_text_with_place_and_types(db): assert ids_of(list_activities(db, ActivityFilter(types=["Hike"], text="out-and-back"))) == ["slavnik2", "slavnik1"]
def test_summarize_takes_text(db): ...
def test_name_contains_ignores_accents(db):
    assert ids_of(list_activities(db, ActivityFilter(name_contains="smarna"))) == ["smarna1"]
def test_gain_bounds(db):
    assert ids_of(list_activities(db, ActivityFilter(types=["Hike"], min_gain_m=1000))) == ["hike1"]
    assert "elevation gain >= 1000 m" in list_activities(db, ActivityFilter(min_gain_m=1000))["counted"]["rules"]
    # an activity with unknown gain passes neither bound
# test_mcp_server.py
def test_list_activities_takes_text_and_gain(ctx): ...
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_activities.py ingest/tests/test_mcp_server.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces above.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: text and elevation-gain filters; name_contains ignores accents`

---

### Task 3: The remaining example queries, and the sizes written down

**Files:**
- Modify: `ingest/tests/test_mcp_queries.py` and `ingest/tests/place_fixture.py` (from plan 1's Task 3, or created here), `ingest/tests/test_mcp_activities.py` (the Slavnik query moves out), `docs/2026-11-22-search-and-gazetteer-design.md`

**Interfaces:**
- Consumes: the tools through `call(ctx, …)`.

- [ ] **Step 1: Write the tests,** one per query, with the query as the docstring:
  - 1: "All hikes to Slavnik": `list_activities(types=["Hike"], place="slavnik")` → `["slavnik2", "slavnik1"]`. This moves `test_place_filter_by_id_and_name`'s name case here; the id case stays.
  - 7: "Rides over Vršič": `types=["Ride"], text="vršič"` → `["vrsic_ride"]`, found through its place name "Prelaz Vršič" (the place filter wants the whole name, and Nominatim doesn't list the pass).
  - 8: "Šmarna gora, typed without accents": `text="smarna gora"` → `["smarna1"]`, and `name_contains="smarna"` → `["smarna1"]`.
  - 9: "Cold rainy walks": `types=["Walk"], text="cold rain"` → `["walk1"]`. The row has no description.
  - 10: "Hikes over 1,000 m of climbing in 2024": `types=["Hike"], min_gain_m=1000, date_from="2024-01-01", date_to="2024-12-31"` → `["hike1"]`.
- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_queries.py -q`. Expected: PASS.
- [ ] **Step 3: Measure on the owner's data,** read-only, after syncing a fresh copy:
  - the database's size, which must be unchanged by this plan
  - the time to build `activity_text` (expect about 20 ms)
  - the time for a two-word `list_activities(text=…)` call
  - the hits for "rain" (expect 20) and "cold" (54) as words

  Write them into "Sizes and budget" in the design doc, next to the database size. In "Done when" on issue #35, the line "The tag, gazetteer and vector tables fit in the database budget" can then be ticked by the owner with these figures: no gazetteer and no vectors, and nothing added to the database.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q && pnpm run test:all`. Expected: PASS.
- [ ] **Step 5: Commit** `test: example queries for text search; docs: search sizes measured`
