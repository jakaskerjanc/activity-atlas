# Search and Gazetteer, Plan 1: The Offline Gazetteer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `find_place` answers from a local place list built from the archived OSM snapshots, and never calls Nominatim. Names match with case and accents ignored, alternative names count, and places near the owner's activities rank first. `activities_near` says how close the nearest activity came when none is inside the radius.

**Architecture:**
- **Building it.** `places:update` fetches two more kinds (towns and cities, huts) and stores the snapshots as now. It then builds two derived files from them: the refresh's points file (unchanged in shape) and a new gazetteer file, `derived/gazetteer/v1-<hash>.sqlite`. `ingest/gazetteer.py` builds the gazetteer and finds the stored one.
- **Getting it.** The MCP server's sync thread fetches the gazetteer with the read-only R2 token after the database check. A fork without R2 reads it from its local archive.
- **Looking up.** `ingest/mcp_server/places.py` is rewritten to look names up in that file, ranking with the activities' bounding boxes.
- **Layering:** `textfold` is a leaf. `gazetteer` imports `textfold` and `osm`. `mcp_server.places` imports `gazetteer` and `textfold`. `osm.main` imports `gazetteer` inside the function, so `gazetteer` → `osm` stays one-way.

**Tech Stack:** Python 3.12 standard library (`sqlite3`, `difflib`, `unicodedata`), the existing `ingest.archive`, `ingest.osm`, `ingest.objstore` and MCP SDK, pytest.

**Spec:** `docs/2026-11-22-search-and-gazetteer-design.md`. Plan 2 (`docs/2026-11-22-search-and-gazetteer-plan-2.md`) adds text search and the remaining example queries. This plan ships on its own.

## Global Constraints

- No new Python dependencies. The MCP server makes no network call except to R2 with the read-only token. Nominatim is gone, with no flag (owner, 2026-11-22).
- **Writers never build the gazetteer.** In CI they don't fetch it either. Only `places:update` builds it.
- **The database doesn't change:** no schema bump, no new table.
- **New Overpass statements,** added inside the union after the `place` line:
  - `node["place"~"^(town|city)$"]["name"](area.a);`
  - `nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"](area.a);`
- **Gazetteer kinds:** the points file's nine (peak, pass, park, water, neighbourhood, quarter, suburb, hamlet, village), plus:
  - `town`, `city`
  - `hut` (`tourism=alpine_hut` or `wilderness_hut`)

  `parse_points` (the refresh's points file) keeps its nine kinds.
- **Name keys,** in this order: `name`, `name:sl`, `name:en`, `name:de`, `name:it`, `alt_name`, `official_name`.
  - Values are split on `;` and stripped.
  - A variant whose folded form equals the main name's folded form is not stored.
  - Duplicate folded variants of one point are stored once.
- **Folding:** `fold_words(s)` is `fold_name(s)` (NFD, combining marks dropped, `casefold`, ł→l, ø→o, đ→d), then every character that isn't a letter or a digit becomes a space, then runs of spaces collapse and the ends are stripped.
- **Match classes,** best first: `exact`, `alternative`, `words`, `starts`, `similar`.
  - `words`: the folded query is a run of whole words of a folded name.
  - `starts`: some word of a folded name starts with the folded query.
  - `similar`: only when no other class matched. `difflib.SequenceMatcher` ratio ≥ 0.8, over folded names whose length is within ±2 of the query's and that start with the same character.
- **Ranking key**, ascending:
  1. `activities_nearby == 0`
  2. the class index
  3. `-activities_nearby`
  4. the kind index in `KIND_ORDER`
  5. `osm_id`

  Where:
  - `KIND_ORDER = ("city", "town", "village", "suburb", "peak", "pass", "hut", "water", "quarter", "hamlet", "neighbourhood", "park")`
  - `activities_nearby` is the number of visible activities whose `min_lat..max_lat` / `min_lng..max_lng` box, widened by `NEARBY_M = 2000`, holds the point.
- **Results:** the top `MAX_CANDIDATES = 5` are returned, and `total_matches` is the count before the cut.
- **Suggested radius** in m, `SUGGESTED_RADIUS_M`:

  | Kind | m |
  |---|---|
  | city | 5000 |
  | town | 3000 |
  | village, suburb | 1500 |
  | quarter, hamlet | 1000 |
  | neighbourhood | 800 |
  | water | 500 |
  | park | 300 |
  | peak, pass | 200 |
  | hut | 150 |
- **Files and names:**
  - Gazetteer key: `derived/gazetteer/v1-<hash>.sqlite`. The hash is `osm.points_file_name(keys)`'s, over the newest snapshot key per country.
  - `GAZETTEER_VERSION = 1`, stored as `PRAGMA user_version`.
  - The same snapshots always build byte-identical files.
- **MCP lookup order:**
  1. `--gazetteer PATH` (a file)
  2. with R2 and without `--no-sync`: `RemoteArchive(read-only store, <db folder>/cache/<bucket>)`
  3. with `--no-sync`: the newest `v1-*.sqlite` in `<db folder>/cache/<bucket>/derived/gazetteer/`
  4. without R2: `LocalArchive(<db folder>/archive)`
- **Tool error text,** copied verbatim:
  - while a download runs: `The offline place list is downloading from R2 ({progress}); try again in a minute.`
  - when there's none: `There is no offline place list yet: run pnpm run places:update SI AT … on a machine with R2 write access (or with the local archive).`
  - `{progress}` is like `12 of 28 MB`.
- **`counted.rules` for `find_place`,** copied verbatim:
  - `offline OpenStreetMap place list: {countries joined by space}, snapshots through {YYYY-MM-DD}`
  - `names compared with case and accents ignored`
  - `ranked: near your activities first, then how well the name matches`
- **`counted.excluded` for `find_place`:** `{"more matches not shown": total_matches - len(candidates)}`.
- **`nearest` in `activities_near`:** only when `total == 0`. It's the nearest activity of the same filter and mode within `MAX_RADIUS_M`, as `{id, date_local, type, name, closest_m}`, or `None`.
  - When it's set, the rule `nearest outside the radius: {closest_m / 1000:.1f} km` is added.
- **Python command:** `$PY` is the main checkout's venv Python (`/…/activity-atlas/.venv/bin/python` on the owner's machine; any venv with `requirements.txt` elsewhere). No absolute home paths in committed files.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The gazetteer is still downloading, or isn't in R2 at all,** when `find_place` is called → the tool error from the Global Constraints, and every other tool answers. Test in Task 5.
2. **A point whose `name` holds a `;` list** ("Gorenja vas;Zgornja vas"), **or an alternative name equal to the name but for accents** → no row is lost, and no variant is stored twice. Test in Task 2.
3. **The same feature in two countries' snapshots** (a peak on the SI–AT border) → one `points` row and no duplicate `alt_names` rows, under the later country in sorted order. Test in Task 2.
4. **A query that is empty, all punctuation, or one character** → `ValueError("query is empty")` for empty and punctuation-only. A one-letter query returns at most 5 candidates, and the typo fallback is skipped for queries under 4 characters. Test in Task 4.
5. **The server replaced its gazetteer (a newer `places:update`) while a `find_place` connection is open** → the next call opens the new file, and the old file is deleted only from the server's own cache folder. Test in Task 5.

---

## File Structure

```
ingest/textfold.py                  # leaf: fold_name, fold_words
ingest/gazetteer.py                 # kinds, rows, build, name, build_and_store, stored_path
ingest/osm.py                       # overpass_query += towns/cities/huts; main builds the gazetteer; --files-only
ingest/mcp_server/filters.py        # fold_name imported from ingest.textfold (re-exported)
ingest/mcp_server/places.py         # rewritten: Gazetteer, find_place
ingest/mcp_server/gazetteer_sync.py # GazetteerSource: which file, fetching it, its status
ingest/mcp_server/freshness.py      # Syncer runs an "after" hook; as_of gains gazetteer
ingest/mcp_server/server.py         # ServerContext.gazetteer; find_place read-only
ingest/mcp_server/__main__.py       # --gazetteer; deletes data/mcp/places.json
ingest/mcp_server/geo.py            # nearest when nothing is inside the radius
ingest/mcp_server/guide.md, README.md
ingest/tests/fixtures/overpass_gazetteer.json
ingest/tests/gazetteer_fixture.py   # builds a fixture gazetteer + activities that use it
ingest/tests/test_textfold.py, test_gazetteer.py, test_mcp_places.py (rewritten), test_mcp_queries.py
```

---

### Task 1: One folding function for every name match

**Files:**
- Create: `ingest/textfold.py`, `ingest/tests/test_textfold.py`
- Modify: `ingest/mcp_server/filters.py` (`fold_name` and `_FOLDS` move out; `from ingest.textfold import fold_name` keeps `filters.fold_name` importable)

**Interfaces:**
- Produces: `fold_name(s: str) -> str`, unchanged behaviour. `fold_words(s: str) -> str`, as in the Global Constraints.

- [ ] **Step 1: Write the failing tests**

```python
from ingest.textfold import fold_name, fold_words
from ingest.mcp_server import filters

def test_fold_name_is_the_filters_one():
    assert filters.fold_name is fold_name
    assert fold_name("Šmarna gora") == "smarna gora" and fold_name("Đurđevac") == "durdevac"

def test_fold_words_drops_punctuation_and_collapses_spaces():
    assert fold_words("Kranjska-Gora") == fold_words("  kranjska   gora ") == "kranjska gora"
    assert fold_words("Cima Lunga / Hudi Vršič") == "cima lunga hudi vrsic"
    assert fold_words("Koča na Golici (1582 m)") == "koca na golici 1582 m"
    assert fold_words("!!") == ""
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_textfold.py -q`. Expected: FAIL (no module `ingest.textfold`).
- [ ] **Step 3: Implement** `ingest/textfold.py`. Move `fold_name` and `_FOLDS` there verbatim, and add `fold_words` (a `re.sub(r"[^\w]+|_", " ", …)` over the folded string, then `" ".join(s.split())`). `filters.py` imports `fold_name` from it.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS (`test_fold_name_folds_letters_nfd_leaves_whole` still passes through the re-export).
- [ ] **Step 5: Commit** `refactor: one name-folding module for places, search and the gazetteer`

---

### Task 2: Build the gazetteer file from the snapshots

**Files:**
- Create: `ingest/gazetteer.py`, `ingest/tests/fixtures/overpass_gazetteer.json`, `ingest/tests/test_gazetteer.py`
- Modify: `ingest/osm.py` (`overpass_query` gains the two statements)
- Test: `ingest/tests/test_osm.py` (the query and `parse_points` ignoring the new kinds)

**Interfaces:**
- Consumes: `osm._ele`, `osm.points_file_name`, `textfold.fold_words`, `Archive.newest_osm_keys/list_osm/get_derived/put_derived`.
- Produces in `ingest/gazetteer.py`:
  - `GAZETTEER_FOLDER = "gazetteer"`, `GAZETTEER_VERSION = 1`
  - `NAME_KEYS = ("name", "name:sl", "name:en", "name:de", "name:it", "alt_name", "official_name")`
  - `gazetteer_kind(tags: dict) -> str | None`: the points file's kinds, plus `town`, `city`, `hut`.
  - `@dataclass(frozen=True) class GazPoint: osm_id: str; kind: str; name: str; lat: float; lon: float; ele: float | None; alt_names: tuple[str, ...]`
  - `gazetteer_points(data: bytes, country: str) -> list[GazPoint]`, with the same JSON checks as `osm.parse_points`. Raises `osm.OsmError`.
  - `gazetteer_file_name(keys: Iterable[str]) -> str`: `osm.points_file_name(keys)`, with the same hash and `v1-` prefix.
  - `build_gazetteer(snapshots: dict[str, bytes], keys: dict[str, str], dest: str) -> dict[str, int]`:
    - writes the schema from the spec (`points`, `alt_names`, `snapshots`) through a temp file renamed into place
    - countries go in sorted order with `INSERT OR REPLACE` on `points`
    - when a later country replaces a point, that point's `alt_names` rows are replaced too
    - `VACUUM` before the rename
    - returns the points per country
  - `build_and_store(archive: Archive) -> str | None`: builds from `archive.list_osm()` and `archive.newest_osm_keys()`, then `put_derived(f"{GAZETTEER_FOLDER}/{name}", …)`. Returns the local path, or None without snapshots.
  - `stored_path(archive: Archive) -> str | None`: `archive.get_derived(f"{GAZETTEER_FOLDER}/{gazetteer_file_name(keys)}")`, or None without snapshots. It never builds and never writes to the store.
- The fixture `overpass_gazetteer.json` is the real Overpass shape with `osm3s.timestamp_osm_base`. It holds:
  - town Jesenice (46.4364, 14.0561)
  - peak Triglav (46.3783, 13.8369), which `test_near_with_place` uses
  - city Ljubljana (46.0511, 14.5051), and a peak named Ljubljana elsewhere
  - peak Slavnik (45.5355, 13.9698) with `alt_name` "Primorski Triglav" and `name:it` "Taiano"
  - pass Prelaz Vršič (46.435, 13.744), and a peak Vršič (46.29, 14.66)
  - water Blejsko jezero (46.3633, 14.0938), a way with `center`, with `name:en` "Lake Bled" and `name:sl` "Blejsko jezero"
  - hut Koča na Golici, `tourism=alpine_hut`
  - a hamlet whose `name` is "Gorenja vas;Zgornja vas"
  - a peak named "Kriz" whose `name:sl` is "Križ" (differs only by accents)
  - an unnamed peak

  A second fixture file, `overpass_gazetteer_at.json`, repeats the Slavnik node (same id) as a border case, with only `name:de` "Monte Taiano".

- [ ] **Step 1: Write the failing tests**

```python
def test_query_fetches_towns_and_huts():
    q = osm.overpass_query("SI")
    assert 'node["place"~"^(town|city)$"]["name"](area.a);' in q
    assert 'nwr["tourism"~"^(alpine_hut|wilderness_hut)$"]["name"](area.a);' in q

def test_points_file_ignores_new_kinds():               # test_osm.py
    names = {p.name for p in parse_points(fixture_bytes("overpass_gazetteer.json"), "SI")}
    assert "Jesenice" not in names and "Koča na Golici" not in names and "Slavnik" in names

def test_kinds_and_alt_names():
    pts = {p.name: p for p in gazetteer_points(fixture_bytes("overpass_gazetteer.json"), "SI")}
    assert pts["Jesenice"].kind == "town"
    assert sorted(p.kind for p in gazetteer_points(fixture_bytes("overpass_gazetteer.json"), "SI")
                  if p.name == "Ljubljana") == ["city", "peak"]
    assert pts["Koča na Golici"].kind == "hut"
    assert set(pts["Slavnik"].alt_names) == {"Primorski Triglav", "Taiano"}
    assert pts["Blejsko jezero"].alt_names == ("Lake Bled",)          # name:sl equals name: not stored

def test_semicolon_names_and_accent_twins():
    pts = {p.name: p for p in gazetteer_points(fixture_bytes("overpass_gazetteer.json"), "SI")}
    assert pts["Gorenja vas"].alt_names == ("Zgornja vas",)   # the first of a ; list is the name
    assert pts["Kriz"].alt_names == ()                         # Križ folds to the same name

def test_border_point_kept_once(tmp_path):
    counts = build_gazetteer({"SI": si, "AT": at}, {"SI": "osm/SI/a.json", "AT": "osm/AT/b.json"}, dest)
    c = sqlite3.connect(dest)
    assert c.execute("SELECT country FROM points WHERE name = 'Slavnik'").fetchall() == [("SI",)]
    assert {r[0] for r in c.execute("SELECT a.name FROM alt_names a JOIN points p USING (osm_id) "
                                    "WHERE p.name = 'Slavnik'")} == {"Primorski Triglav", "Taiano"}  # AT's replaced

def test_same_snapshots_same_bytes(tmp_path): ...       # two builds → identical file bytes
def test_records_snapshot_keys(tmp_path): ...           # snapshots table == keys; user_version == 1
def test_build_and_store_then_stored_path(tmp_path):    # LocalArchive with two snapshots
    a = LocalArchive(str(tmp_path / "arch")); a.put_osm("SI", si, fetched_at="2026-11-22T10:00:00+00:00")
    assert stored_path(a) is None
    path = build_and_store(a)
    assert stored_path(a) == path and os.path.basename(path) == gazetteer_file_name(a.newest_osm_keys().values())
def test_stored_path_never_writes_to_the_store(): ...   # RemoteArchive over MemoryStore without the key → None, store unchanged
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_gazetteer.py ingest/tests/test_osm.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `overpass_query` and `ingest/gazetteer.py` as in the Interfaces above. In each `points` row, `folded` is `fold_words(name)`. Rows are inserted in `(country, osm_id)` order, so the bytes are deterministic.
- [ ] **Step 4: Run** the same tests, then `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: build an offline gazetteer from the OSM snapshots`

---

### Task 3: `places:update` builds and stores the gazetteer

**Files:**
- Modify: `ingest/osm.py` (`main`)
- Test: `ingest/tests/test_osm.py`

**Interfaces:**
- Consumes: `gazetteer.build_and_store(archive)`.
- Produces:
  - `places:update SI AT …` stores the snapshots, runs `writer.run` as today, then calls `build_and_store(archive)`. It prints the per-country counts of both files: `SI: 19144 points, 19449 in the place list`.
  - `places:update --files-only` takes no countries. It fetches nothing and builds both files from the stored snapshots: `osm.points_file(archive)`, then `build_and_store`. With no snapshots it exits 1 with `places:update: the archive has no OSM snapshots; run places:update SI AT … first`.
  - Countries and `--files-only` can't be combined (argparse error).

- [ ] **Step 1: Write the failing tests**

```python
def test_update_stores_the_gazetteer(tmp_path, monkeypatch): ...   # fake fetch_country → snapshot stored, derived/gazetteer/<name> exists
def test_files_only_builds_without_fetching(tmp_path, monkeypatch): ...  # fetch_country raises if called; both derived files appear
def test_files_only_without_snapshots_exits_1(tmp_path): ...
def test_files_only_rejects_countries(): ...                       # SystemExit 2
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_osm.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Make `countries` `nargs="*"` and add `--files-only`. `main` imports `gazetteer` inside the function.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: places:update stores the offline place list; --files-only rebuilds from snapshots`

---

### Task 4: Look names up in the gazetteer

**Files:**
- Modify: `ingest/mcp_server/places.py` (rewritten; `PlaceFinder`, Nominatim, the JSON cache and `PlaceLookupError` go)
- Create: `ingest/tests/gazetteer_fixture.py`
- Test: `ingest/tests/test_mcp_places.py` (rewritten)

**Interfaces:**
- Consumes: `textfold.fold_words`, the gazetteer schema, `Database.conn`, `activities.counted`.
- Produces in `places.py`:
  - `KIND_ORDER`, `SUGGESTED_RADIUS_M`, `NEARBY_M = 2000`, `MAX_CANDIDATES = 5` and `MATCH_CLASSES = ("exact", "alternative", "words", "starts", "similar")`, with the values from the Global Constraints.
  - `class Gazetteer`:
    - `__init__(self, path: str)` opens the file `mode=ro`.
    - `countries: list[str]` and `snapshots_through: str` (the newest date among the snapshot keys' stamps, as `YYYY-MM-DD`).
    - `close()`.
  - `find_place(gaz: Gazetteer, db: Database, query: str) -> dict`, with the result shape:

    ```python
    {"data": {"query": str, "total_matches": int, "candidates": [
        {"name", "matched_name" (None unless an alternative or similar name matched), "match", "kind", "lat", "lon",
         "elevation_m" (rounded int or None), "country", "osm_id", "activities_nearby", "suggested_radius_m"}]},
     "counted": counted([...three rules...], len(candidates), {"more matches not shown": n})}
    ```

    - Raises `ValueError("query is empty")` when `fold_words(query) == ""`.
    - The typo fallback runs only when the folded query has ≥ 4 characters.
    - Step 2 of the spec's matching is one SQL statement over `points` and `alt_names`. The typo fallback is a second one, plus `difflib`.
    - `activities_nearby` is one query over visible activities with `min_lat` not NULL, compared with every candidate in Python.
- Produces in `gazetteer_fixture.py`:
  - `build_fixture_gazetteer(dir: str) -> str`, built with `gazetteer.build_gazetteer` from `overpass_gazetteer.json`.
  - `add_place_activities(conn) -> None`, which inserts, with `mcp_fixture._insert_activity` and synthetic tracks:
    - `jes_hike`: a Hike that starts 800 m from Jesenice and climbs north
    - `jes_walk`: a Walk in town
    - `vrsic_ride`: a Ride over Prelaz Vršič
    - `bled_walk`: a Walk around the lake, 400–600 m from its centre
    - `lj_run1`, `lj_run2`: Runs starting within 2 km of Ljubljana's centre
    - `far_hike`: a Hike whose closest point is 12 km from Jesenice

- [ ] **Step 1: Write the failing tests**

```python
def test_town_beats_nothing_nearby(gdb):
    r = find_place(gaz, db, "Jesenice")
    c = r["data"]["candidates"][0]
    assert (c["name"], c["kind"], c["match"], c["suggested_radius_m"]) == ("Jesenice", "town", "exact", 3000)
    assert c["activities_nearby"] >= 2
    assert r["counted"]["rules"][0].startswith("offline OpenStreetMap place list: SI, snapshots through ")

def test_near_activities_outrank_a_better_name(gdb):
    names = [c["name"] for c in find_place(gaz, db, "Vršič")["data"]["candidates"]]
    assert names[0] == "Prelaz Vršič" and "Vršič" in names[1:]          # words-match with a ride nearby first

def test_alternative_name(gdb):
    c = find_place(gaz, db, "lake bled")["data"]["candidates"][0]
    assert (c["name"], c["match"], c["matched_name"]) == ("Blejsko jezero", "alternative", "Lake Bled")

def test_city_before_the_peak_of_the_same_name(gdb):
    assert [c["kind"] for c in find_place(gaz, db, "ljubljana")["data"]["candidates"][:2]] == ["city", "peak"]

def test_word_start(gdb): assert find_place(gaz, db, "golici")["data"]["candidates"][0]["kind"] == "hut"
def test_typo(gdb):
    c = find_place(gaz, db, "slavnk")["data"]["candidates"][0]
    assert (c["name"], c["match"]) == ("Slavnik", "similar")
def test_no_typo_fallback_under_4_chars(gdb): ...
def test_not_in_the_list(gdb):
    r = find_place(gaz, db, "Odense")
    assert r["data"]["candidates"] == [] and "SI" in r["counted"]["rules"][0]
@pytest.mark.parametrize("q", ["", "   ", "!!"])
def test_empty_query(gdb, q): pytest.raises(ValueError, find_place, gaz, db, q)
def test_at_most_five_and_excluded_count(gdb): ...       # "a" → ≤ 5 candidates, excluded["more matches not shown"] == total - 5
def test_hidden_activities_do_not_count_as_nearby(gdb): ...
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_places.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `places.py` and the fixture helpers as in the Interfaces above.
- [ ] **Step 4: Run** `$PY -m pytest ingest/tests/test_mcp_places.py -q`. Expected: PASS. (`test_mcp_server.py` fails until Task 5; that's expected.)
- [ ] **Step 5: Commit** `feat: find_place looks names up in the offline gazetteer`

---

### Task 5: The MCP server gets the gazetteer and uses it

**Files:**
- Create: `ingest/mcp_server/gazetteer_sync.py`
- Modify:
  - `ingest/mcp_server/freshness.py` (`Syncer(..., after: Callable[[], None] | None = None)`, run on the sync thread after each database check, whatever its outcome; `as_of(db, syncer, gazetteer=None)` adds `"gazetteer": gazetteer.status_dict()`)
  - `ingest/mcp_server/server.py` (`ServerContext.places` → `gazetteer: GazetteerSource`; `find_place` is `READ_ONLY`; its docstring drops "only the name leaves the machine")
  - `ingest/mcp_server/__main__.py` (`--gazetteer PATH`; deletes `<db folder>/mcp/places.json` if present)
- Test: `ingest/tests/test_mcp_freshness.py`, `ingest/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `gazetteer.stored_path`, `gazetteer.GAZETTEER_FOLDER`, `RemoteArchive`, `LocalArchive`, `places.Gazetteer`, `places.find_place`.
- Produces: `class GazetteerSource`:
  - `__init__(self, *, file: str | None, archive: Archive | None, cache_folder: str | None, off: bool)`, where:
    - `file` is `--gazetteer`
    - `archive` is the RemoteArchive (R2) or LocalArchive (no R2) from the lookup order in the Global Constraints
    - `cache_folder` is `<db folder>/cache/<bucket>/derived/gazetteer`
    - `off` is `--no-sync`
  - `refresh(self) -> None` runs on the sync thread:
    - with `file` or `off`, it does nothing
    - otherwise it sets `status` to `downloading` while `stored_path(archive)` runs, then to `ready`
    - when it's ready, it deletes the other `v1-*.sqlite` files in `cache_folder` only
    - it catches every exception into `status = f"failed: {exc}"`
  - `open(self) -> Gazetteer` is called under the server lock:
    - It returns the Gazetteer for the current path. When the path has changed since the last call, it reopens.
    - With no file, it raises `ValueError` with one of the two texts from the Global Constraints, picked by `status`.
    - The newest local file under `cache_folder` (when `off`) or the archive's derived folder counts as current until `refresh` finds another.
  - `status_dict(self) -> dict`: `{"countries": [...], "snapshots_through": "YYYY-MM-DD"}` when a file is open, else `{"status": status}`.
- `__main__` wires it like this:
  - with R2 and without `--no-sync`: `GazetteerSource(file=args.gazetteer, archive=RemoteArchive(store_ro, <db folder>/cache/<bucket>), cache_folder=…, off=False)`, and `Syncer(..., after=source.refresh)`
  - without R2: `archive=LocalArchive(<db folder>/archive)`, and `refresh` runs once at start

- [ ] **Step 1: Write the failing tests**

```python
# test_mcp_freshness.py
def test_after_hook_runs_on_the_sync_thread_even_when_up_to_date(tmp_path): ...
def test_gazetteer_downloads_with_read_only_store_and_never_writes(tmp_path):
    # MemoryStore holds osm/SI/<key> and derived/gazetteer/<name>; source.refresh() → file in cache_folder;
    # the store's keys are unchanged afterwards
def test_newer_gazetteer_replaces_the_old_file_in_its_own_folder_only(tmp_path): ...   # a stray file elsewhere stays
def test_no_sync_uses_the_cached_file_without_listing(tmp_path): ...                   # store.list raises if called
# test_mcp_server.py
def test_find_place_is_read_only_and_offline(ctx):
    tools = asyncio.run(build_server(ctx).list_tools())
    assert {t.name for t in tools if t.annotations.read_only_hint} == TOOLS - {"sync"}
    assert call(ctx, "find_place", {"query": "Jesenice"})["data"]["candidates"][0]["kind"] == "town"
def test_find_place_while_downloading(ctx_downloading):
    with pytest.raises(ToolError, match="The offline place list is downloading from R2"): ...
def test_find_place_without_a_gazetteer(ctx_none):
    with pytest.raises(ToolError, match="There is no offline place list yet"): ...
    assert call(ctx_none, "list_activities", {})["data"]["total"] > 0             # other tools still work
def test_as_of_reports_the_gazetteer(ctx): assert call(ctx, "guide", {})["as_of"]["gazetteer"]["countries"] == ["SI"]
def test_places_json_cache_is_removed_on_start(tmp_path): ...
```

  The `ctx` fixture builds `GazetteerSource(file=build_fixture_gazetteer(tmp), archive=None, cache_folder=None, off=True)`. It also calls `add_place_activities`, so counts that pin the fixture's size (`test_query_tool`'s `[[12]]`) go up by the seven new activities. `test_near_with_place` keeps passing against the fixture's Triglav point, which Task 2's fixture adds.

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_freshness.py ingest/tests/test_mcp_server.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces above. In `server.run`, `ValueError` from `gazetteer.open()` already becomes a `ToolError`. Remove `PlaceLookupError` from the caught exceptions.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS, with no test touching the network.
- [ ] **Step 5: Commit** `feat: MCP server fetches the offline place list from R2; find_place makes no network call`

---

### Task 6: `activities_near` reports the nearest when nothing is inside

**Files:**
- Modify: `ingest/mcp_server/geo.py` (`activities_near`)
- Test: `ingest/tests/test_mcp_geo.py`

**Interfaces:**
- Produces: `data["nearest"]`, present on every result: `None` when `total > 0`, else as in the Global Constraints. When `nearest` is set, the rule `nearest outside the radius: 12.3 km` is added. The search runs the existing candidate pass again with `MAX_RADIUS_M` and keeps the smallest `closest_m`.

- [ ] **Step 1: Write the failing tests**

```python
def test_nothing_inside_reports_nearest(gdb):
    r = activities_near(db, 46.4364, 14.0561, 3000, "route", ActivityFilter(types=["Hike"], ...exclude jes_hike...))
    assert r["data"]["total"] == 0 and r["data"]["nearest"]["id"] == "far_hike"
    assert 11500 < r["data"]["nearest"]["closest_m"] < 12500
    assert any(x.startswith("nearest outside the radius: 1") for x in r["counted"]["rules"])
def test_nearest_is_none_when_something_is_inside(gdb): ...
def test_nearest_none_beyond_50_km(gdb): ...                       # a point in the sea far from every track
def test_nearest_respects_mode_start(gdb): ...
```

  The first test needs a filter that leaves out `jes_hike`. Use `date_to` before its date: put `far_hike` earlier than `jes_hike` in the fixture.
- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_geo.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Factor the candidate pass into `_hits(db, lat, lon, radius_m, mode, where, params) -> list[dict]` and call it a second time with `MAX_RADIUS_M` only when the first returns nothing.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: activities_near says how close the nearest activity came`

---

### Task 7: The example queries for places, the docs and the rollout

**Files:**
- Create: `ingest/tests/test_mcp_queries.py`
- Modify: `ingest/mcp_server/guide.md` ("Which tool", "Definitions", "Known limits"), `README.md` (the MCP section), `docs/2026-11-22-search-and-gazetteer-design.md` ("Sizes and budget")

**Interfaces:**
- Consumes: everything above, through `build_server(ctx).call_tool`, as an LLM would call it.

- [ ] **Step 1: Write the tests.** One per query, with the query as the docstring. Each calls the tools through `call(ctx, …)` and checks ids, as in the spec's table:
  - 2: "Hiking near Jesenice" → `["jes_hike"]`
  - 3: "Hiking near Jesenice, none close" → `nearest.id == "far_hike"`
  - 4: "Rides over Vršič" → `["vrsic_ride"]`
  - 5: "Walks around Lake Bled" → `["bled_walk"]`
  - 6: "Runs from Ljubljana" → `["lj_run1", "lj_run2"]`, in `closest_m` order
  - 10: "A place in a country not loaded" → no candidates
  - 11: "A typo" → Slavnik

  Each test reads `suggested_radius_m` from `find_place` and passes it on. None hard-codes a radius.
- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_queries.py -q`. Expected: PASS. (They pin the chain; any failure is a bug in Tasks 4–6, not in the test.)
- [ ] **Step 3: Update the docs.**
  - **`guide.md`:**
    - The `find_place` line in "Which tool" says: offline; peaks, passes, huts, lakes, parks and settlements from hamlet to city, in the loaded countries; places near the owner's activities first; confirm with the user when several fit; start from `suggested_radius_m`. Streets, shops and addresses aren't in it.
    - "Definitions" gains the match classes and the `nearest` field.
    - "Known limits" gains: "Countries not downloaded aren't in the place list; `as_of.gazetteer.countries` lists those that are."
  - **`README.md`:** replace the Nominatim sentence with the spec's: "Only the conversation leaves your machine. Place names are looked up in an offline list built from OpenStreetMap by `places:update`." Then add one line: "After `places:update`, the server downloads that list (about 28 MB) once with the read-only token."
- [ ] **Step 4: Run** `$PY -m pytest ingest -q && pnpm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `test: example place queries; docs: offline find_place`
- [ ] **Step 6: Rollout, on the owner's machine, after merge.** Run `PYTHON_BIN=$PY pnpm run places:update SI AT IT NO IS`, and add DK and the other countries if the owner says so (design, open questions). It refetches with the new kinds and stores both files.
  - Then, read-only: record in the design doc's "Sizes and budget" the gazetteer file's bytes and gzip size, the points per country, the new snapshot sizes and the refreshed points file's size. Also record the database size, which must be unchanged except for the refresh's own renames.
  - Commit: `docs: gazetteer sizes measured`.
  - Check by hand in Claude Code, with the server started with `--no-sync` and the machine offline, that `find_place("Jesenice")` returns the town.
