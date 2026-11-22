# Search and Gazetteer, Plan 1: Place Lookup and "Near"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `find_place` puts Nominatim's candidates near the owner's activities first and suggests a radius for each. `activities_near` says how close the nearest activity came when none is inside the radius. "Hiking near Jesenice" and four more place queries pass as tests.

**Architecture:**
- **`find_place`.** `PlaceFinder` (`ingest/mcp_server/places.py`) keeps calling Nominatim, now with `limit=10`. It caches the raw candidates, and at call time ranks them with one read of the activities' bounding boxes.
- **`activities_near`.** `geo.activities_near` runs its candidate pass a second time, with the 50 km maximum, only when the first finds nothing.
- **No offline gazetteer, no schema change.** Nominatim stays (owner, 2026-11-22).

**Tech Stack:** Python 3.12 standard library, the existing `ingest.mcp_server` modules and MCP SDK, pytest.

**Spec:** `docs/2026-11-22-search-and-gazetteer-design.md`. Plan 2 (`docs/2026-11-22-search-and-gazetteer-plan-2.md`) adds text search and the remaining example queries. The two plans don't depend on each other. Whichever runs second adds its tests to `test_mcp_queries.py` and `place_fixture.py`.

## Global Constraints

- No new dependencies, no schema change, no network in tests (Nominatim is mocked, as today).
- **Only the place name goes to Nominatim,** with the existing User-Agent and the one-request-a-second wait. `find_place` keeps its `open_world` annotation.
- **Request params:** `{"q": query.strip(), "format": "jsonv2", "limit": 10, "extratags": 1}`.
- **Cache:**
  - the file is `<db folder>/mcp/places-v2.json`, keyed by `query.strip().lower()` as now
  - each entry holds up to 10 candidates in Nominatim's order, each with `addresstype` and `boundingbox` (`[south, north, west, east]` as floats) on top of today's fields
  - `__main__` deletes `<db folder>/mcp/places.json` if it exists
- **`NEARBY_M = 2000`.** A candidate's `activities_nearby` is the number of visible activities with `min_lat` not NULL whose `min_lat..max_lat`, `min_lng..max_lng` box, widened by 2000 m (with `geo.M_PER_DEG_LAT` and the cosine of the candidate's latitude), holds the candidate's point.
- **Ranking key**, ascending: `(activities_nearby == 0, -activities_nearby, nominatim_index)`. The top `MAX_CANDIDATES = 5` are returned.
- **`SUGGESTED_RADIUS_M`**, by `addresstype`, else by `type`:

  | Kind | m |
  |---|---|
  | city | 5000 |
  | town | 3000 |
  | village, suburb | 1500 |
  | quarter, hamlet | 1000 |
  | neighbourhood | 800 |
  | lake, water, reservoir | 500 |
  | park | 300 |
  | peak, saddle, mountain_pass | 200 |
  | alpine_hut, wilderness_hut | 150 |

  Any other kind: half the `boundingbox` diagonal (haversine, corner to corner), rounded to 100 m, clamped to `[200, 50000]`. With no `boundingbox`, 1000.
- **Result data:** `{"query", "candidates", "total_candidates", "cached"}`.
  - Each candidate has `name`, `kind` (`category/type` as today), `lat`, `lon`, `elevation_m`, `country`, `activities_nearby` and `suggested_radius_m`. `addresstype` and `boundingbox` stay in the cache only.
- **`counted.rules`,** copied verbatim:
  - `OpenStreetMap Nominatim, up to 10 candidates`
  - `ranked: candidates near your activities first, then Nominatim's order`
- **`counted.excluded`:** `{"more candidates not shown": total_candidates - len(candidates)}`.
- **`nearest` in `activities_near`:** every result has `data["nearest"]`.
  - It's `None` when `total > 0`.
  - Otherwise it's the activity of the same filter and mode with the smallest closest distance within `MAX_RADIUS_M`, as `{id, date_local, type, name, closest_m}`, or `None` when there's none.
  - When it's set, the rule `nearest outside the radius: {closest_m / 1000:.1f} km` is added.
- **Python command:** `$PY` is the main checkout's venv Python. No absolute home paths in committed files.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An old-format cache entry** (5 candidates, no `addresstype` or `boundingbox`) → never read, because the file name changed. The old file is deleted on start, and the new file starts empty. Test in Task 1.
2. **The server has no database yet** (still downloading) when `find_place` is called → the existing "no local database" tool error, as for every tool. No ranking without activities. Test in Task 1.
3. **A candidate with a malformed `boundingbox`** (missing, strings, three values) → `suggested_radius_m` 1000, no crash. Test in Task 1.
4. **Activities without GPS, or hidden ones, near a candidate** → not counted in `activities_nearby`. Test in Task 1.
5. **`activities_near` with mode `start` or `end` and nothing inside** → `nearest` uses the same mode's distance, not the closest point of the route. Test in Task 2.

---

## File Structure

```
ingest/mcp_server/places.py      # limit 10, cache v2, ranking, suggested radius; find(query, db)
ingest/mcp_server/server.py      # find_place passes ctx.db; docstring
ingest/mcp_server/__main__.py    # places-v2.json; deletes places.json
ingest/mcp_server/geo.py         # nearest when nothing is inside
ingest/mcp_server/guide.md
ingest/tests/place_fixture.py    # activities around real places + Nominatim mock bodies
ingest/tests/test_mcp_places.py, test_mcp_geo.py, test_mcp_queries.py
```

---

### Task 1: Rank Nominatim's candidates by the owner's activities

**Files:**
- Modify: `ingest/mcp_server/places.py`, `ingest/mcp_server/server.py` (`find_place` calls `ctx.places.find(query, ctx.db)`; the docstring adds "candidates near your activities come first; each has suggested_radius_m for activities_near"), `ingest/mcp_server/__main__.py`
- Create: `ingest/tests/place_fixture.py`
- Test: `ingest/tests/test_mcp_places.py`, `ingest/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: `Database.conn`, `geo.haversine_m`, `geo.M_PER_DEG_LAT`, `activities.counted`.
- Produces in `places.py`:
  - `NEARBY_M`, `MAX_CANDIDATES`, `SUGGESTED_RADIUS_M`, as in the Global Constraints
  - `suggested_radius_m(c: dict) -> int`, over a cached candidate
  - `PlaceFinder.find(self, query: str, db: Database) -> dict`, with the result shape from the Global Constraints
- Produces in `place_fixture.py`:
  - `add_place_activities(conn) -> None`, which inserts, with `mcp_fixture._insert_activity` and synthetic tracks:
    - `jes_hike` (2025-06-01): a Hike that starts 800 m from Jesenice town (46.432, 14.062) and climbs north
    - `jes_walk`: a Walk in town
    - `far_hike` (2025-05-01): a Hike whose closest point is 12 km from the town
    - `bled_walk`: a Walk 400–600 m from Blejsko jezero's centre (46.364, 14.094)
    - `lj_run1`, `lj_run2`: Runs that start within 2 km of Ljubljana (46.050, 14.507)
    - `vrsic_ride`: a Ride over Prelaz Vršič (46.435, 13.744), with place `vrsic1` "Prelaz Vršič" (kind pass) in `places` and `activity_groups`

    All are visible, with gain NULL. Add `jes_hidden`, a hidden Hike next to Jesenice.
  - `NOMINATIM: dict[str, list[dict]]`: mock bodies for "jesenice", "slavnik", "lake bled" and "ljubljana", in the field shape Nominatim returned on 2026-11-22 (`name`, `display_name`, `category`, `type`, `addresstype`, `lat`, `lon`, `boundingbox` as strings, `extratags`). They're in the design's order, except "slavnik", which puts the Serbian village first, to test the ranking.
  - `fetch(url, params) -> list[dict]`, a stub that serves `NOMINATIM[params["q"].lower()]`, records calls, and returns `[]` for other names.

- [ ] **Step 1: Write the failing tests**

```python
def test_request_asks_for_ten(tmp_path, pdb):
    f = Fetch(); PlaceFinder(str(tmp_path / "p.json"), fetch=f).find("Jesenice", pdb)
    assert f.calls[0][1] == {"q": "Jesenice", "format": "jsonv2", "limit": 10, "extratags": 1}

def test_candidates_near_activities_first(tmp_path, pdb):
    r = finder(tmp_path).find("Jesenice", pdb)
    top = r["data"]["candidates"][:2]
    assert {c["country"] for c in top} == {"Slovenija"} and all(c["activities_nearby"] > 0 for c in top)
    assert r["data"]["total_candidates"] == 9 and len(r["data"]["candidates"]) == 5
    assert r["counted"]["excluded"] == {"more candidates not shown": 4}
    assert "ranked: candidates near your activities first, then Nominatim's order" in r["counted"]["rules"]

def test_nominatim_order_when_nothing_is_near(tmp_path, pdb): ...   # a mock with no activity nearby → same order
def test_ranking_beats_nominatims_order(tmp_path, pdb):
    assert finder(tmp_path).find("Slavnik", pdb)["data"]["candidates"][0]["kind"] == "natural/peak"
def test_hidden_and_gps_less_activities_do_not_count(tmp_path, pdb): ...   # jes_hidden adds nothing
@pytest.mark.parametrize("c,expected", [
    ({"addresstype": "town", "type": "town"}, 3000), ({"addresstype": "lake", "type": "lake"}, 500),
    ({"addresstype": "peak", "type": "peak"}, 200), ({"addresstype": "hamlet"}, 1000),
    ({"addresstype": "municipality", "boundingbox": [46.40, 46.49, 13.99, 14.15]}, 7900),  # half the 15.8 km diagonal
    ({"addresstype": "road", "boundingbox": [46.0, 46.0001, 14.0, 14.0001]}, 200),       # clamped up
    ({"addresstype": "state", "boundingbox": [40, 50, 10, 20]}, 50000),                  # clamped down
    ({"addresstype": "x"}, 1000), ({"addresstype": "x", "boundingbox": ["a", 1]}, 1000)])
def test_suggested_radius(c, expected): assert suggested_radius_m(c) == expected
def test_cache_keeps_ten_raw_and_ranks_at_call_time(tmp_path, pdb): ...   # second call: no fetch; add an activity → order changes
def test_old_cache_file_is_deleted_on_start(tmp_path): ...                # __main__ helper removes mcp/places.json
# test_mcp_server.py: existing find_place tests pass with the db argument; the no-database error is unchanged
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_places.py ingest/tests/test_mcp_server.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces above. `_candidate` also keeps `addresstype` and `boundingbox` (floats, or None when unparseable). `find` loads the boxes once per call, `SELECT min_lat, max_lat, min_lng, max_lng FROM activities WHERE visible = 1 AND min_lat IS NOT NULL`, and counts per candidate in Python.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: find_place ranks candidates near your activities first and suggests a radius`

---

### Task 2: `activities_near` reports the nearest when nothing is inside

**Files:**
- Modify: `ingest/mcp_server/geo.py` (`activities_near`)
- Test: `ingest/tests/test_mcp_geo.py`

**Interfaces:**
- Produces: `data["nearest"]` and the rule, as in the Global Constraints. The candidate pass moves into `_hits(db, lat, lon, radius_m, mode, where, params) -> list[dict]`. `activities_near` calls it again with `MAX_RADIUS_M` only when the first call returns nothing.

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

### Task 3: Example place queries, and the guide

**Files:**
- Create: `ingest/tests/test_mcp_queries.py`
- Modify: `ingest/mcp_server/guide.md`

**Interfaces:**
- Consumes: the tools through `build_server(ctx).call_tool`, as an LLM calls them. A `qctx` fixture in this file builds the MCP fixture, calls `add_place_activities`, and wires `PlaceFinder(..., fetch=place_fixture.fetch)`. `test_mcp_server.py`'s `ctx` is left alone, so its pinned counts don't move.

- [ ] **Step 1: Write the tests,** one per query from the design's table, with the query as the docstring. Each reads `suggested_radius_m` from `find_place` and passes it on. None hard-codes a radius.
  - 2: "Hiking near Jesenice": the first candidate is the Slovenian municipality or town → `activities_near(types=["Hike"])` gives `["jes_hike"]`.
  - 3: "Hiking near Jesenice, none close": with `date_to="2025-05-31"`, `nearest.id == "far_hike"`.
  - 4: "Slavnik, with the Serbian village first in Nominatim's answer": the SI peak first.
  - 5: "Walks around Lake Bled" → `["bled_walk"]`.
  - 6: "Runs from Ljubljana": `mode="start"` → `["lj_run1", "lj_run2"]`, in `closest_m` order.
- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_queries.py -q`. Expected: PASS (they pin the chain; a failure is a bug in Tasks 1–2).
- [ ] **Step 3: Update `guide.md`:**
  - The `find_place` line in "Which tool" says:
    - candidates near the owner's activities come first, and `activities_nearby` says how many
    - start `activities_near` from `suggested_radius_m`
    - for a summit or pass the owner reached, `places` and the place filter come first, because Nominatim may not list it ("Vršič" returns ten peaks and not the pass)
  - "Definitions" gains: "When nothing is inside the radius, `activities_near` gives `nearest`: the closest activity of the same filter within 50 km. Say how far it was rather than just 'none'."
- [ ] **Step 4: Run** `$PY -m pytest ingest -q && pnpm run test`. Expected: PASS.
- [ ] **Step 5: Commit** `test: example place queries; docs: ranked find_place and nearest`
