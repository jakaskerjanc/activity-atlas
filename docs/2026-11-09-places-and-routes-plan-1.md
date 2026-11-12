# Places and Same-Route Groups, Plan 1: Data and MCP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every database write, every visible GPS activity gets its place and same-route group, each named automatically. The MCP server can filter by place and list an activity's same route.

**Architecture:** The pure geometry, grouping and naming modules take plain data and return plain data. One `refresh(conn)` in `ingest/refresh.py` loads activities and OSM points from the database, runs them, and writes only the rows that changed. `writer.run` calls it after every write job, so the daily fetch, imports, rebuild and the `activity` CLI all keep groups current without a new CI step. A refresh that fails never costs the job its work: the database is still uploaded, and the run exits 7. Imports go one way: `geometry` ← `grouping` ← `naming` ← `refresh`, `osm` takes `OsmPoint` from `naming`, and `writer` imports `refresh` inside `run`. OSM named points come from a per-country Overpass download that the owner runs (`places:update`). The raw responses are stored in the archive, so a rebuild needs no network.

**Tech Stack:** Python 3.12 standard library only, plus the existing `polyline`, `ingest.codec`, `ingest.archive`, `ingest.writer`, `ingest.engine` and `ingest.db`, the MCP SDK already in use, and pytest.

**Spec:** `docs/2026-11-08-place-tags-design.md`. Plan 2 (`docs/2026-11-09-places-and-routes-plan-2.md`) builds the site on top of this one.

## Global Constraints

- No new Python dependencies. No network in the daily CI job: only `places:update` calls Overpass.
- **Module layering** (no import cycles, whichever module loads first):
  - `geometry` is a leaf.
  - `grouping` imports `geometry` and `codec` only.
  - `naming` defines `OsmPoint` and imports `geometry` and `grouping`'s types.
  - `osm` imports `OsmPoint` from `naming`, plus `writer`, `engine` and `archive`.
  - `refresh` imports `grouping`, `naming` and `db`.
  - `writer.run` imports `refresh_file` inside the function, the way `engine.open_for_write` imports `rebuild`.
- **Places:**
  - Altitude is smoothed with a centred 15-sample moving average. The top is the highest smoothed sample.
  - An activity gets a place only if its top is ≥ 50 m above the smoothed altitude 15 samples in.
  - A place's anchor radius is 500 m.
- **Same route:**
  - The track is the polyline, resampled to 64 points evenly by distance.
  - Candidates have the same type, distances `a` and `b` with `abs(a - b) <= 0.15 * max(a, b)`, and the start of one within 1 km of the start or end of the other.
  - The route matches when discrete Fréchet < 250 m in either direction.
- **Grouping:** chronological by `(start_time, id)`. Each item joins the first group whose anchor matches. The group id is the anchor activity's id. Groups cover visible activities only.
- **Shape:**
  - point-to-point: the end is more than 200 m from the start
  - out-and-back: otherwise, when ≥ 70% of the second half lies within 50 m of the first half
  - loop: otherwise
- **Place names, in this order:**
  1. the owner's name
  2. a word repeated in ≥ 2 of the place's non-default activity names; skipped for one-activity places. Words match only when equal after lowercasing, with no stemming, so "Šmarno" and "Šmarna" differ. The name keeps the spelling (case and diacritics) of the earliest activity name that has the phrase, unless an OSM peak or pass nearby starts with it.
  3. the nearest OSM peak or pass within 400 m of the place's highest top
  4. `Top at {ele} m`
- **Default names:** names like "Morning Hike" and "‹town› Walking/Hiking/Running/…" count as default and add no words.
- **Height:** the `ele` of the OSM peak or pass within 400 m when there is one, otherwise the top rounded to 10 m.
- **Point naming:** the nearest point of the first kind with a hit, in this order: peak/pass 150 m, park 250 m, water 150 m, neighbourhood 800 m, quarter or hamlet 1000 m, suburb 1500 m, village 2000 m.
- **Route base:**
  - a route with a place: `"{place name} {shape}"`, with its true shape (a point-to-point too)
  - otherwise, a point-to-point whose start and end are both named and the names differ: `"{start} → {end}"`
  - otherwise, when the turnaround has a name: `"{turnaround name} {shape}"`, where point-to-point reads as `loop`
  - otherwise (no OSM point in range, as for the demo data, a fork before `places:update`, or a country not downloaded): `"{km:.1f} km {shape}"` from the anchor's distance, with the true shape, e.g. "5.2 km loop" or "12.0 km point-to-point"
- **Route tiebreaks** (within one type, when bases collide), first that makes the name unique:
  1. `via` the point farthest from the others, ignoring the first and last 500 m
  2. `via` a feature within 75 m of this route and > 150 m from the others
  3. `, {km:.1f} km`, skipped when the base already carries the distance
  4. `, since {Mon YYYY}`
  5. `, since {D Mon YYYY}`; if names still collide, the second and later in anchor order add ` (2)`, ` (3)`, … This one always ends the chain.
- **Writes:** only rows that differ are written. A write job with no new data leaves the file byte-identical.
- **Refresh failure:** `writer.run` catches it, keeps and uploads the job's work as now, leaves the group tables as they were, and only then exits with `EXIT_REFRESH_FAILED = 7`.
- **Python command:** `$PY` is the repo venv's Python (`.venv/bin/python`). In a worktree, point it at the main checkout's `.venv`. No absolute home paths in committed files.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A GPS activity with no streams row, no altitude, or `None` holes in altitude** (9 of 446 have only a polyline) → it gets no place, can still join a route group, and nothing crashes. Test in Task 3.
2. **The anchor of a place is hidden or merged away** → the next activity becomes the anchor. An owner name keyed by the old id is reported as orphaned by `refresh`, never moved to another place silently, and `name-place <old id> ""` clears it. A place merged into another is not an orphan; a merge whose target is gone is. Tests in Tasks 4, 6 and 7.
3. **Overpass answers 429, 504, HTML instead of JSON, or a 200 whose JSON carries a `remark` (a timeout or out-of-memory, with partial or empty `elements`), or a country with zero points** → `places:update` stops with a clear message before writing anything to the archive or the database. Test in Task 2.
4. **Tracks far north (Lofoten, 68° N)** → projection is local to the anchor's first point, so a 100 m offset still reads as about 100 m. Test in Task 3.
5. **`refresh` meets a v4 database** (before the automatic rebuild) or a file with no activities → it does nothing and raises nothing. Test in Task 6. **The MCP server reads a v4 database** (for up to a day after this lands) → `places`, `same_route` and the `place` filter raise `ValueError(NO_PLACES_YET)`, which the server returns as a tool error, and every other tool works. Test in Task 8.
6. **The refresh raises** (new code over every historical track) → the daily fetch's work is still uploaded and snapshotted, the group tables stay as they were, and the run exits 7 with a message. Same on the local-archive path. Test in Task 6.

---

## File Structure

```
ingest/db.py            # schema v5: osm_points, places, route_groups, activity_groups, group_overrides
ingest/archive.py       # osm/<CC>/<stamp>-<sha12>.json: put_osm, list_osm (remote: newest per country only)
ingest/osm.py           # Overpass query, parse_points, apply_osm, places:update CLI; OsmPoint from naming
ingest/geometry.py      # leaf: haversine_m, project, resample, discrete_frechet, smooth, track_top, route_shape, farthest_index
ingest/grouping.py      # pure: ActivityTrack, load_tracks, Groups, group_activities
ingest/naming.py        # OsmPoint, PointIndex, is_default_name, name_words, name_places, name_routes
ingest/refresh.py       # refresh, refresh_file
ingest/writer.py        # run(): refresh_file after work (imported inside run), EXIT_REFRESH_FAILED = 7
ingest/rebuild.py       # carry group_overrides; re-apply OSM snapshots
ingest/demo/build.py    # refresh the demo database
ingest/activity_cli.py  # places, routes, name-place, merge-place, unmerge-place, name-route
ingest/mcp_server/      # filters.place + resolve_place, activities.places/same_route, server tools, guide.md
package.json            # "places:update"
ingest/tests/track_fixture.py   # synthetic tracks + insert helper
ingest/tests/test_osm.py, test_geometry.py, test_grouping.py, test_naming.py, test_refresh.py
```

---

### Task 1: Schema v5 and the OSM area of the archive

**Files:**
- Modify: `ingest/db.py` (`SCHEMA_VERSION = 5`, new tables, module docstring)
- Modify: `ingest/archive.py` (`put_osm`, `list_osm` on `LocalArchive` and `RemoteArchive`, `Archive` protocol, layout docstring)
- Test: `ingest/tests/test_db.py`, `ingest/tests/test_archive.py`

**Interfaces:**
- Produces these tables:

```sql
CREATE TABLE osm_points (osm_id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, ele REAL, country TEXT NOT NULL);
CREATE INDEX idx_osm_points_lat ON osm_points(lat);
CREATE TABLE places (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_source TEXT NOT NULL,
  kind TEXT NOT NULL, ele REAL NOT NULL);
CREATE TABLE route_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_source TEXT NOT NULL);
CREATE TABLE activity_groups (activity_id TEXT PRIMARY KEY, place_id TEXT, route_id TEXT);
CREATE TABLE group_overrides (kind TEXT NOT NULL, group_id TEXT NOT NULL, name TEXT,
  merge_into TEXT, PRIMARY KEY (kind, group_id));
```

  - `kind` in `osm_points`: `peak|pass|park|water|neighbourhood|quarter|suburb|hamlet|village`.
  - `name_source` for places: `owner|activity_names|osm|fallback`; for routes: `owner|auto`.
  - `places.kind`: `peak|pass|top`.
  - `group_overrides.kind`: `place|route`.
- Produces: `put_osm(self, country: str, data: bytes, *, fetched_at: str) -> bool`, stored at `osm/<CC>/<stamp>-<sha12>.json`. It returns False, writing nothing, when the newest stored snapshot for that country has the same bytes. Every Overpass response carries its own `osm3s.timestamp_osm_base`, so in practice a re-download stores a new snapshot; the check only catches a repeated identical body.
- Produces: `list_osm(self) -> dict[str, bytes]`, the newest snapshot per country (newest = the last key in sort order).
  - `RemoteArchive.list_osm` lists the keys under `osm/`, validates every key as `_sync` does (it starts with the prefix and each part passes `_safe`; `ValueError` otherwise), and fetches only the newest key per country that isn't cached. Older snapshots are never downloaded.
  - `RemoteArchive.put_osm` does the same for `osm/<CC>/` before comparing.
- The raw responses are larger than the design's 871 KB for Slovenia, which measures the parsed points. Plan 2's Task 7 measures both.

- [ ] **Step 1: Write the failing tests**

```python
# test_db.py
def test_v4_database_needs_rebuild(tmp_path): ...  # user_version 4 → NeedsRebuild
def test_v5_has_group_tables(): conn = fresh(); assert {"osm_points","places","route_groups","activity_groups","group_overrides"} <= table_names(conn)
# test_archive.py
def test_put_osm_dedupes_and_list_returns_newest(tmp_path):
    a = LocalArchive(str(tmp_path))
    assert a.put_osm("SI", b'{"elements":[]}', fetched_at="2026-11-09T10:00:00+00:00")
    assert not a.put_osm("SI", b'{"elements":[]}', fetched_at="2026-11-09T11:00:00+00:00")
    assert a.put_osm("SI", b'{"elements":[1]}', fetched_at="2026-11-10T10:00:00+00:00")
    assert a.list_osm() == {"SI": b'{"elements":[1]}'}
def test_put_osm_rejects_unsafe_country(tmp_path): with pytest.raises(ValueError): LocalArchive(str(tmp_path)).put_osm("../x", b"", fetched_at=...)
def test_remote_list_osm_fetches_only_newest_per_country(...)  # store has two SI snapshots and one AT → returns the newest of each; the older SI key is never fetched (not in the store's get calls, not in the cache)
def test_remote_list_osm_rejects_unsafe_store_key(...)  # a key "osm/../x.json" in the store → ValueError, nothing fetched
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_db.py ingest/tests/test_archive.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement the schema and archive methods** as above. Country codes must match `^[A-Z]{2}$` (`ValueError` otherwise). The first write job after this lands rebuilds the database from the archive through `open_for_write`, as earlier schema bumps did. New tables carry no data a rebuild can't recreate, except `group_overrides`, which Task 6 carries over.
- [ ] **Step 4: Run** the same tests and then `$PY -m pytest ingest -q`. Expected: PASS. Any test that pins `SCHEMA_VERSION == 4` is updated to 5.
- [ ] **Step 5: Commit** `feat: schema v5 group tables and OSM snapshots in the archive`

---

### Task 2: OSM named points and `places:update`

**Files:**
- Create: `ingest/osm.py`, `ingest/naming.py` (only `OsmPoint` for now; Task 5 adds the rest), `ingest/tests/fixtures/overpass_si_small.json` (about 10 elements, hand-written in the real Overpass shape, with `osm3s.timestamp_osm_base`)
- Modify: `package.json` (`"places:update": "${PYTHON_BIN:-python3} -m ingest.osm"`)
- Test: `ingest/tests/test_osm.py`

**Interfaces:**
- Consumes: `Archive.put_osm`/`list_osm`, `writer.run`, `engine.open_for_write`, `naming.OsmPoint`, the `osm_points` table.
- Produces in `naming.py`: `@dataclass(frozen=True) class OsmPoint: osm_id: str; kind: str; name: str; lat: float; lon: float; ele: float | None`. `osm` imports it from there; `naming` never imports `osm`.
- Produces in `osm.py`:
  - `OVERPASS_URL = "https://overpass-api.de/api/interpreter"`
  - `USER_AGENT = "activity-atlas/0.1 (+https://github.com/jakaskerjanc/activity-atlas)"`
  - `REQUEST_GAP_S = 5`
  - `overpass_query(country: str) -> str`, in exactly this form:

```
[out:json][timeout:900];
area["ISO3166-1"="{CC}"][admin_level=2]->.a;
(
  nwr["natural"~"^(peak|saddle)$"]["name"](area.a);
  nwr["mountain_pass"="yes"]["name"](area.a);
  nwr["leisure"="park"]["name"](area.a);
  nwr["natural"="water"]["name"](area.a);
  node["place"~"^(neighbourhood|quarter|suburb|hamlet|village)$"]["name"](area.a);
);
out center tags;
```

  - `parse_points(data: bytes, country: str) -> list[OsmPoint]`
    - The position is `lat/lon`, or `center` for ways and relations. `osm_id` is `"{type}/{id}"`.
    - Kinds: `natural=peak` → peak; `natural=saddle` or `mountain_pass=yes` → pass; `leisure=park` → park; `natural=water` → water; `place` → its value.
    - `ele` is the leading number of the tag, so "1028", "1028 m" and "1028,5" all parse, or None.
    - Elements without a name or a position are dropped.
    - Invalid JSON, or JSON without `elements`, raises `OsmError`.
    - JSON with a `remark` raises `OsmError` carrying the remark. Overpass reports a timeout or out-of-memory as HTTP 200 with a body like `{"osm3s": {…}, "elements": [<partial or none>], "remark": "runtime error: Query timed out in \"query\" at line 3 after 181 seconds."}`, and that body must never replace a country's rows.
  - `apply_osm(conn, snapshots: dict[str, bytes]) -> int`: for each country, replaces that country's `osm_points` rows with `parse_points` and returns the row count. It doesn't commit.
  - `fetch_country(country: str, post=_http_post) -> bytes`: one POST of `data=<query>` with the `User-Agent`. Any non-200 response, a body that `parse_points` rejects, or a body that parses to zero points raises `OsmError(f"{country}: …")`.
  - `main()`: `places:update SI AT …` with `--db` and `--archive`.
    1. Fetch every country first, waiting `REQUEST_GAP_S` between requests.
    2. Only when every country succeeded: `put_osm` each response.
    3. Then `writer.run(db, archive, work, today=date.today().isoformat())`. `work(path)` opens the database with `engine.open_for_write(path, archive, now=now_iso())`, so a v4 file is rebuilt first, then calls `apply_osm(conn, archive.list_osm())`, commits and closes.
    4. Print the rows per country.
  - `class OsmError(Exception)`

- [ ] **Step 1: Write the failing tests**

```python
def test_query_names_country(): assert 'area["ISO3166-1"="SI"]' in overpass_query("SI")
def test_parse_kinds_and_center():
    pts = {p.name: p for p in parse_points(fixture_bytes("overpass_si_small.json"), "SI")}
    assert pts["Slavnik"].kind == "peak" and pts["Slavnik"].ele == 1028
    assert pts["Vršič"].kind == "pass"
    assert pts["Park Tivoli"].kind == "park" and pts["Park Tivoli"].osm_id.startswith("way/")  # from center
    assert pts["Koseze"].kind == "neighbourhood"
def test_parse_ele_variants(): ...  # "1028 m" → 1028, "1028,5" → 1028.5, "approx" → None
def test_parse_drops_unnamed_and_positionless(): ...
def test_parse_rejects_html(): with pytest.raises(OsmError): parse_points(b"<html>rate limited</html>", "SI")
def test_parse_rejects_remark(): ...  # 200-style body with one peak in elements and remark "runtime error: Query timed out in \"query\" at line 3 after 181 seconds." → OsmError matching "timed out"
def test_apply_replaces_only_that_country(conn): ...  # SI then AT then SI again: AT rows untouched
def test_fetch_raises_on_429(): post = lambda *a, **k: (429, b"Too Many Requests"); with pytest.raises(OsmError, match="SI: .*429"): fetch_country("SI", post)
def test_fetch_raises_on_zero_points(): post = lambda *a, **k: (200, b'{"osm3s":{},"elements":[]}'); with pytest.raises(OsmError, match="SI: "): fetch_country("SI", post)
def test_main_writes_nothing_when_one_country_fails(tmp_path, monkeypatch): ...  # SI ok, AT 504 → archive has no osm/ keys, db has no osm_points
def test_main_writes_nothing_when_a_country_times_out(tmp_path, monkeypatch): ...  # SI ok, AT 200 with a remark → archive has no osm/ keys, db has no osm_points
def test_main_rebuilds_a_v4_database_and_loads_points(tmp_path, monkeypatch): ...  # local archive, db with user_version 4 → user_version 5 afterwards, osm_points filled
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_osm.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement `ingest/osm.py`** and the `OsmPoint` stub in `naming.py` to the interfaces above. `_http_post` uses `urllib.request` with a 240 s timeout and returns `(status, body)`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: places:update downloads OSM named points per country`

---

### Task 3: Track geometry

**Files:**
- Create: `ingest/geometry.py`, `ingest/tests/track_fixture.py`
- Test: `ingest/tests/test_geometry.py`

**Interfaces:**
- Produces in `geometry.py`, a leaf module, where all distances are metres and points are `(lat, lon)` or projected `(x, y)`:
  - `haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float`
  - `project(points: Sequence[tuple[float, float]], origin: tuple[float, float]) -> list[tuple[float, float]]`: equirectangular around `origin`, with x scaled by `cos(origin lat)`.
  - `resample(xy: Sequence[tuple[float, float]], n: int = 64) -> list[tuple[float, float]]`: evenly spaced by path length. A zero-length path gives `n` copies of the first point.
  - `discrete_frechet(p: Sequence[tuple[float, float]], q: Sequence[tuple[float, float]]) -> float`
  - `smooth(values: Sequence[float], window: int = 15) -> list[float]`: centred moving average that uses the samples available at the edges.
  - `@dataclass(frozen=True) class Top: lat: float; lon: float; ele: float; climb: float`
  - `track_top(lats, lons, alts) -> Top | None`
    - Uses only samples where all three values are present, and needs at least 30 of them.
    - `climb` = smoothed max − smoothed value at index 15 (clamped to the last sample).
    - Returns None when the climb is under 50.
  - `route_shape(xy: Sequence[tuple[float, float]]) -> str`: returns `"loop"`, `"out-and-back"` or `"point-to-point"` (thresholds in Global Constraints).
  - `farthest_index(xy, skip_m: float = 0.0) -> int`: the index farthest from `xy[0]`. Points within `skip_m` of the first or last point are ignored; when every point is ignored, it falls back to the plain farthest point.
- Produces in `track_fixture.py` (tests only):
  - `line(start: tuple, bearing_deg: float, length_m: float, n: int) -> list[tuple]`
  - `loop(center: tuple, radius_m: float, n: int, start_deg: float = 0) -> list[tuple]`
  - `out_and_back(start, bearing_deg, length_m, n)`
  - `offset(points, east_m: float, north_m: float)`
  - `climb_alts(n, gain_m)`: rises evenly to the midpoint, then falls.
  - `insert_activity(conn, id_, type_, start_utc, points, *, alts=None, name=None, distance=None, visible=1)`: wraps `mcp_fixture._insert_activity`. `distance` defaults to the path length.

- [ ] **Step 1: Write the failing tests**

```python
def test_haversine_one_degree_lat(): assert abs(haversine_m(46, 14, 47, 14) - 111_195) < 50
def test_project_far_north_keeps_metres():
    a = (68.2, 13.6); b = offset([a], east_m=100, north_m=0)[0]
    (x0, y0), (x1, y1) = project([a, b], a); assert abs(math.hypot(x1 - x0, y1 - y0) - 100) < 1
def test_resample_even_spacing(): ...  # 64 points, consecutive gaps equal within 1 m on a 3 km line
def test_frechet_identical_zero_and_offset(): ...  # same line → 0; offset 100 m east → ≈100
def test_frechet_reversed_is_large(): ...  # out-and-back vs its reverse > 1000 on a 5 km line
def test_top_needs_50_m_climb(): ...  # gain 49 → None; gain 120 → climb ≈ 120 within 5
def test_top_ignores_single_spike(): ...  # one sample +300 m on a flat track → None
def test_top_skips_none_holes(): ...  # altitude with None every 7th sample → still a Top
def test_top_none_without_altitude(): assert track_top([46.0]*40, [14.0]*40, [None]*40) is None
def test_shapes(): ...  # loop(r=800) → "loop"; out_and_back → "out-and-back"; line(5 km) → "point-to-point"
def test_farthest_index_skips_ends(): ...  # spike within 400 m of start ignored with skip_m=500
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_geometry.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement `geometry.py`** to the interfaces above. `discrete_frechet` is the standard dynamic-programming table, row by row, in plain Python.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: track geometry for places and same-route groups`

---

### Task 4: Grouping places and same routes

**Files:**
- Create: `ingest/grouping.py` (the pure part only; it imports `geometry` and `codec`, nothing else from `ingest`)
- Test: `ingest/tests/test_grouping.py`

**Interfaces:**
- Consumes: `geometry.*`, `codec.decode`, `track_fixture.*`.
- Produces:
  - Constants: `PLACE_RADIUS_M = 500`, `ROUTE_POINTS = 64`, `ROUTE_DISTANCE_TOLERANCE = 0.15`, `ROUTE_START_NEAR_M = 1000`, `ROUTE_MAX_FRECHET_M = 250`.
  - `ActivityTrack`:

```python
@dataclass(frozen=True)
class ActivityTrack:
    id: str
    type: str
    start_time: str              # UTC ISO, the sort key with id
    start_local: str | None
    name: str
    distance: float | None
    line: tuple[tuple[float, float], ...]   # decoded activities.polyline
    top: Top | None
```

  - `load_tracks(conn) -> list[ActivityTrack]`
    - Covers `visible = 1` activities with a non-empty polyline of at least 2 points, sorted by `(start_time, id)`.
    - `top` comes from the `streams` row (`lat`, `lon`, `altitude` decoded with `codec.decode`), or is None without one.
  - `@dataclass(frozen=True) class Groups: place_of: dict[str, str]; route_of: dict[str, str]; place_anchors: frozenset[str]`
    - `route_of` only includes groups with ≥ 2 members.
    - `place_anchors` holds every place anchor id from the grouping before merges are applied, so a place merged into another is still in it. `refresh` uses it to tell orphaned overrides from merged-away places.
  - `group_activities(tracks: Sequence[ActivityTrack], merges: Mapping[str, str] = {}) -> Groups`
    - **Places:** over tracks with a `top`, in order. Each track joins the first existing place whose anchor top is within `PLACE_RADIUS_M` (haversine), or else starts one. `merges` maps a place id to its target and is applied after the grouping; chains are followed, and a merge into an id that isn't in `place_anchors` is ignored.
    - **Routes:** per type, in order, over tracks with a `distance`. A track joins the first group whose anchor passes all of: `abs(a - b) <= ROUTE_DISTANCE_TOLERANCE * max(a, b)` for the two distances, start within 1 km of the anchor's start or end, and `min(frechet(a, b), frechet(a, reversed(b))) < 250`. Both tracks are projected around the anchor's first point and resampled to 64 points.

- [ ] **Step 1: Write the failing tests** (synthetic tracks around 45.6° N; 3 km loops; climbs of 300 m)

```python
def test_hikes_to_same_top_share_a_place(): ...  # 3 hikes, tops within 200 m, different trails → one place id == first hike's id
def test_tops_600_m_apart_are_two_places(): ...
def test_place_anchoring_does_not_chain(): ...  # tops A, A+400 m, A+800 m in that order → B joins A, C starts its own (800 > 500 from anchor A)
def test_flat_run_has_no_place(): ...  # gain 20 m → id not in place_of
def test_activity_without_altitude_gets_route_but_no_place(): ...
def test_place_spans_types(): ...  # a Ride and a Hike to the same top → same place
def test_merge_moves_activities_and_follows_chains(): ...  # merges {B: A, C: B} → all three map to A; merge into missing id ignored
def test_place_anchors_keep_merged_away_places(): ...  # merges {B: A} → B in place_anchors, no activity maps to B
def test_same_loop_either_direction_is_one_route(): ...  # loop and its reverse, 20 m offset
def test_different_loop_from_same_start_is_another_route(): ...  # second loop's far side 400 m away
def test_route_needs_same_type(): ...  # identical Run and Walk → no route_of entries
def test_route_needs_distance_within_15_percent(): ...  # 3.0 km vs 3.6 km same start → none; 3.0 km vs 3.5 km → one group (15% of the longer)
def test_singletons_have_no_route(): ...
def test_route_ids_are_anchor_ids_and_stable_when_newer_added(): ...  # add a later member → ids unchanged
def test_missing_distance_skips_route_grouping(): ...
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_grouping.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `ActivityTrack`, `load_tracks`, `Groups` and `group_activities` in `grouping.py`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: group activities into places and same routes`

---

### Task 5: Naming places and routes

**Files:**
- Modify: `ingest/naming.py` (Task 2 created it with `OsmPoint`)
- Test: `ingest/tests/test_naming.py`

**Interfaces:**
- Consumes: `grouping.ActivityTrack`, `grouping.Groups`, `geometry.*`, `OsmPoint` (same module). `naming` imports `geometry` and `grouping` only, never `osm` or `refresh`.
- Produces:
  - `class PointIndex`: `__init__(self, points: Iterable[OsmPoint])` builds a 0.05° grid; `near(self, lat, lon, radius_m, kinds: Collection[str]) -> list[tuple[float, OsmPoint]]` returns the hits sorted by distance. An empty index is valid and finds nothing.
  - `POINT_RADII: tuple[tuple[tuple[str, ...], float], ...] = ((("peak", "pass"), 150), (("park",), 250), (("water",), 150), (("neighbourhood",), 800), (("quarter", "hamlet"), 1000), (("suburb",), 1500), (("village",), 2000))`
  - `name_point(lat, lon, index: PointIndex) -> str | None`: the nearest point of the first kind tuple with a hit.
  - `is_default_name(name: str) -> bool`, true for:
    - `^\W*(morning|afternoon|evening|night|lunch)\s+(run|ride|hike|walk|swim|workout)\W*$` (case-insensitive, leading emoji allowed)
    - `^\W*.+\s+(walking|hiking|running|trail running|cycling|road cycling|mountain biking|biking|gravel cycling)\s*$` (case-insensitive)
  - `name_words(name: str) -> list[str]`: lowercase letter runs of length ≥ 3, without `GENERIC_WORDS`. No stemming. That set includes at least:
    - morning afternoon evening night lunch hike hiking walk walking run running ride riding trail the to and of with via from on at up down summit attempt day trip loop tour gravel bike cycling
    - effort and time words that aren't places: easy tempo long short recovery weekend hill hills spin after work commute interval intervals race monday tuesday wednesday thursday friday saturday sunday
    - the remaining words of the demo's `FLAVORS` (`ingest/demo/build.py`): riverside forest dinner
    - Slovenian: na in do od po pri čez pohod izlet sprehod tek vzpon krog okoli iz proti nad pod ob kolo
  - `@dataclass(frozen=True) class PlaceInfo: id: str; name: str; name_source: str; kind: str; ele: float`
  - `@dataclass(frozen=True) class RouteInfo: id: str; name: str; name_source: str`
  - `name_places(groups, tracks, index, owner_names: Mapping[str, str]) -> dict[str, PlaceInfo]`
    - Rules 1 to 4 as in Global Constraints.
    - In rule 2 a word counts once per activity name and must appear in ≥ 2 names. The most common word wins, ties broken by first appearance, and a bigram with the same count is preferred.
    - The name is the phrase as spelled in the earliest activity name (by `(start_time, id)`) that contains it: the matched letter runs in their original case and diacritics, joined by one space. "Velika planina" stays "Velika planina", never "velika planina".
    - If a peak or pass within 400 m has a name that starts with the chosen phrase (case-insensitive), the OSM spelling is used instead. Either way `name_source` is `activity_names`.
    - Height and kind come from that OSM peak or pass when there is one; otherwise the place's highest top rounded to 10 m, with `kind="top"`.
    - The fallback name reads `Top at 1,070 m`, with a thousands comma.
  - `name_routes(groups, tracks, places: Mapping[str, PlaceInfo], index, owner_names) -> dict[str, RouteInfo]`: a route's place is `groups.place_of` of its anchor.
    - Base and tiebreaks as in Global Constraints, computed from each route's anchor track. Every route gets a non-empty name, including with an empty `PointIndex`.
    - `start → end` needs both `name_point` results to be non-None and different. A turnaround whose `name_point` is None gives the unnamed base `"{km:.1f} km {shape}"`, from the anchor's `distance`, with the true shape.
    - The month in `since {Mon YYYY}` and the date in `since {D Mon YYYY}` come from the anchor's `start_local` (its `start_time` when that is None), in English (`since May 2024`, `since 3 May 2024`).
    - The ` (2)`, ` (3)` suffix goes to the second and later routes in anchor order `(start_time, id)`; the first keeps its name.
    - Owner names win and take no part in collisions.

- [ ] **Step 1: Write the failing tests**

```python
def test_default_names(): assert is_default_name("☀️ Morning Hike") and is_default_name("Ljubljana Walking") and not is_default_name("Slavnik summit attempt")
def test_place_from_repeated_words_uses_osm_spelling(): ...  # names "Šmarna z Mojco", "Jutranja Šmarna", OSM peak "Šmarna gora" 40 m away → "Šmarna gora", source activity_names
def test_case_endings_are_not_a_repeat(): ...  # names "Na Šmarno", "Šmarna z Mojco", OSM peak "Šmarna gora" 40 m away → "Šmarna gora", source osm
def test_place_name_keeps_activity_spelling(): ...  # two hikes "Velika planina", "Velika planina s Tejo", nearest OSM peak "Gradišče" 200 m → "Velika planina", source activity_names
def test_place_ignores_default_town_names(): ...  # 4× "Ljubljana Walking" + OSM "Šišenski hrib" 60 m → "Šišenski hrib", source osm
def test_effort_words_never_name_a_place(): ...  # "Easy run", "Weekend ride", "Hill ride", "Tempo run" names, no OSM → "Top at …", source fallback
def test_single_activity_place_skips_words(): ...  # one "Test Shitbox" + OSM "Peštota" → "Peštota"
def test_place_owner_name_wins(): ...
def test_place_fallback_top_at(): ...  # no OSM within 400 m, top 1068 → "Top at 1,070 m", kind "top", ele 1070
def test_place_height_from_osm(): ...  # OSM peak ele 1028 → ele 1028, kind "peak"
def test_point_name_prefers_peak_then_park_then_neighbourhood(): ...
def test_route_with_place_uses_place_name_and_shape(): ...  # "Slavnik out-and-back"
def test_flat_loop_named_after_turnaround(): ...  # neighbourhood "Koseze" 300 m from the far point → "Koseze loop"
def test_flat_loop_without_osm_named_by_distance(): ...  # empty PointIndex, 5.2 km loop → "5.2 km loop"; 12 km line → "12.0 km point-to-point"
def test_point_to_point_start_to_end(): ...  # "Rožna dolina → Vrtača"; same names both ends → "<turnaround> loop"
def test_point_to_point_with_one_named_end_falls_back(): ...  # start "Koseze", end and turnaround unnamed → "12.0 km point-to-point", never "Koseze → None"
def test_collision_via_divergence_ignores_first_500_m(): ...  # two loops share turnaround; diverge 1.2 km out near "Rožnik" vs "Ribnik"; a feature 300 m from start never chosen
def test_collision_falls_back_to_distance_then_since(): ...  # same everything but start stretch → ", 10.0 km" when distances differ to 0.1 km, else ", since May 2024"
def test_unnamed_routes_with_same_distance_get_distinct_names(): ...  # empty PointIndex, two 5.2 km loops: anchors in May and Jun 2024 → "5.2 km loop, since May 2024" / "…, since Jun 2024" (no ", 5.2 km"); anchors 3 and 17 May 2024 → "…, since 3 May 2024" / "…, since 17 May 2024"; same day → the later anchor ends " (2)"
def test_route_names_unique_within_type(): ...  # a mixed set of routes, once with the fixture's OSM points and once with an empty PointIndex: names unique per type and non-empty both times
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_naming.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement `naming.py`** to the interfaces above. This is the divergence `via` (tiebreak 1), which neither the signatures nor the tests pin down:

```python
# for route r among routes sharing a base (all projected around r's first point, resampled to 64):
d_i = min over other routes o of min_j |r_i - o_j|      # per point of r
ignore i where |r_i - r_0| < 500 or |r_i - r_last| < 500
via = name_point(r at argmax d_i); use it if via is not None, not in base, and no other colliding route got the same via
```

- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: automatic names for places and same routes`

---

### Task 6: Refresh on every write

**Files:**
- Create: `ingest/refresh.py` (`refresh`, `refresh_file`)
- Modify: `ingest/writer.py` (`run`, `EXIT_REFRESH_FAILED`), `ingest/garmin_fetch.py` (`main`'s `work`), `ingest/rebuild.py` (`_kept_state`, `rebuild`), `ingest/demo/build.py` (`build`), `data/demo/activities.sqlite` (regenerated)
- Test: `ingest/tests/test_refresh.py`, `ingest/tests/test_writer.py`, `ingest/tests/test_garmin_fetch.py`, `ingest/tests/test_rebuild.py`

**Interfaces:**
- Consumes: Tasks 1–5. `refresh` imports `grouping`, `naming` and `db`.
- Produces in `refresh.py`:
  - `refresh(conn) -> dict[str, Any]`
    - Loads tracks, `osm_points` (into a `PointIndex`) and `group_overrides`.
    - Computes groups and names, then brings `places`, `route_groups` and `activity_groups` to the computed state using only the INSERT, UPDATE and DELETE statements needed. It doesn't commit.
    - Returns `{"places": int, "routes": int, "rows_changed": int, "no_osm_nearby": int, "orphaned_overrides": list[str]}`.
      - `no_osm_nearby` counts places with no `peak`/`pass` point within 10 km of their highest top.
      - `orphaned_overrides` lists the `group_overrides` rows that point at nothing:
        - a `place` row whose `group_id` isn't in `groups.place_anchors` (the anchors before merges, so a merged-away place is not an orphan);
        - a `place` row whose `merge_into` isn't in `groups.place_anchors`;
        - a `route` row whose `group_id` isn't a route group id.
  - `refresh_file(path: str, log=print) -> dict | None`
    - Returns None when the file is missing or its `user_version` isn't `db.SCHEMA_VERSION`.
    - Otherwise it runs `refresh`, commits only if `rows_changed`, and closes.
    - On any exception it rolls back, closes and re-raises, so the file keeps its previous group tables.
    - It prints `"{n} places have no OSM data nearby; run pnpm run places:update"` when `no_osm_nearby` is above 0 and `osm_points` isn't empty, and one line per orphaned override, naming the `name-place`/`name-route ID ""` or `unmerge-place ID` command that clears it.
- Produces in `writer.py`:
  - `EXIT_REFRESH_FAILED = 7`
  - `run` calls `refresh_file(path)` after `work(path)` returns, on both the local and the remote path, before hashing. It imports it inside the function (`from ingest.refresh import refresh_file`), never at module level.
  - Any `Exception` from `refresh_file` is caught. The traceback goes to stderr, and the run carries on with the hash check, upload, snapshot and prune exactly as now, including the 412 retry. Only then, instead of returning `result`, it prints `"the database was saved (and uploaded if it changed), but places and routes were not refreshed; see the error above"` to stderr and raises `SystemExit(EXIT_REFRESH_FAILED)`.
  - The local-archive path does the same: the work is kept, then exit 7.
- `garmin_fetch.main`'s `work` prints the traceback of an error it hands back, to stderr, when it catches it. Exit 7 ends the run before `main` can re-raise that error, so without this a fetch error that coincides with a refresh failure would never be shown.
- `rebuild` carries `group_overrides` like `activity_overrides`, reading an old file without the table as none. After the records and wellness are applied it calls `osm.apply_osm(conn, archive.list_osm())`.
- The demo `build` calls `refresh.refresh_file(out_path)` after the import, before the `VACUUM`. The demo keeps its places and routes, so a fork shows the feature. With no OSM data, its places are named from the place words in the demo route names, or `Top at … m`, and its flat routes get the unnamed base `"{km} km {shape}"`.

- [ ] **Step 1: Write the failing tests**

```python
# test_refresh.py (fresh v5 db + track_fixture activities + a few osm_points rows)
@pytest.mark.parametrize("mod", ["osm", "naming", "grouping", "refresh", "writer", "rebuild"])
def test_each_module_imports_first(mod): subprocess.run([sys.executable, "-c", f"import ingest.{mod}"], check=True)  # fresh interpreter: no import cycle
def test_refresh_fills_tables(conn): ...  # places/route_groups/activity_groups rows as group_activities + naming say
def test_second_refresh_changes_nothing(tmp_path):
    path = build_db(tmp_path); refresh_file(path); before = sha256(path)
    assert refresh_file(path)["rows_changed"] == 0 and sha256(path) == before
def test_hiding_the_anchor_reanchors_and_reports_orphaned_name(conn): ...  # owner name on old anchor → in orphaned_overrides, new place has auto name
def test_merged_away_place_is_not_orphaned(conn): ...  # merge B into A → B not in orphaned_overrides, B has no places row
def test_merge_into_missing_target_is_orphaned(conn): ...  # merge B into A, then hide A's only activity → B's row in orphaned_overrides
def test_refresh_error_leaves_file_unchanged(tmp_path, monkeypatch): ...  # name_routes raises → refresh_file raises, file byte-identical
def test_refresh_skips_v4_and_missing(tmp_path): assert refresh_file(str(tmp_path / "none.sqlite")) is None  # and a user_version=4 file → None, file unchanged
def test_no_osm_warning_only_with_osm_data(tmp_path, capsys): ...
# test_writer.py
def test_unchanged_run_still_uploads_nothing(...)  # existing no-change test passes with refresh in place; add: work that inserts one hike → activity_groups row present in the uploaded db
def test_refresh_failure_still_uploads_and_exits_7(...)  # remote: work inserts an activity, refresh_file raises (patch ingest.refresh.refresh_file, which run imports at call time) → the uploaded db and the snapshot have the activity, SystemExit code 7, traceback on stderr
def test_refresh_failure_local_keeps_work_and_exits_7(...)  # local archive: same, the file at db_path has the activity, SystemExit code 7
# test_garmin_fetch.py
def test_handed_back_error_is_printed_when_caught(...)  # the fetcher raises inside work → its traceback is on stderr before writer.run returns
# test_rebuild.py
def test_rebuild_keeps_place_names_and_merges(...)
def test_rebuild_restores_osm_points_from_archive(...)
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_refresh.py ingest/tests/test_writer.py ingest/tests/test_garmin_fetch.py ingest/tests/test_rebuild.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `refresh.py`, the `writer.run` hook, the `garmin_fetch` traceback, the rebuild carry-over and the demo build call.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Regenerate the demo database** with `PYTHON_BIN=$PY pnpm run build:demo`, then run `pnpm run test`. Expected: the build-tracks tests pass, including "the committed demo database builds a complete site". Then print the demo's names: `$PY -c "import sqlite3; c = sqlite3.connect('data/demo/activities.sqlite'); print([r[0] for r in c.execute('SELECT name FROM places')]); print([r[0] for r in c.execute('SELECT name FROM route_groups')])"`. Expected: places named after places in the demo route names or `Top at … m`, routes as `{place} {shape}` or `{km} km {shape}`. None is an effort or time word such as "Easy", "Weekend" or "Hill"; if one is, add the word to `GENERIC_WORDS` with a test and regenerate.
- [ ] **Step 6: Check against real data,** on a copy and never the real file.
  1. Copy `data/activities.sqlite` from the main checkout to the scratchpad.
  2. The copy is still v4, so give it the five new tables from `db.SCHEMA` and `PRAGMA user_version = 5`. This shortcut is for the check only; real databases go through the automatic rebuild.
  3. Run `$PY -c "import sys; from ingest.refresh import refresh_file; print(refresh_file(sys.argv[1]))" <copy>`.
  4. Compare with `SELECT count(*) FROM route_groups` and the Slavnik place's count. Expected: close to the design's measured figures, without OSM data loaded:
  - 19 route groups (8 run, 7 hike, 4 walk)
  - 23 places with ≥ 2 rides, hikes or walks
  - one place with 29 hikes
- [ ] **Step 7: Commit** `feat: refresh places and same routes on every database write`

---

### Task 7: Owner names and merges in the `activity` CLI

**Files:**
- Modify: `ingest/activity_cli.py`
- Test: `ingest/tests/test_activity_cli.py`

**Interfaces:**
- Consumes: `group_overrides`, `places`, `route_groups`, `activity_groups`, and `refresh`, which runs via `writer.run`.
- Produces:
  - `list_places(conn) -> list[dict]`: one dict per place with `id, name, name_source, kind, ele, count`. Places with `name_source == "fallback"` come first, then the rest by count descending.
  - `list_routes(conn) -> list[dict]`: one dict per route with `id, type, name, name_source, count, first, last` (local dates).
  - `name_group(conn, kind: str, group_id: str, name: str) -> None`
    - A non-empty `name` needs an existing group (a `places` or `route_groups` row); otherwise `ValueError`.
    - Naming a place that has a merge row raises `ValueError` naming its target ("place B is merged into A; name A instead").
    - An empty `name` clears the name. It is allowed for any id with a `group_overrides` row, including an orphaned one that has no group any more, so the orphan report can always be cleared. An id with neither a group nor a row raises `ValueError`.
    - A row left with neither a name nor a merge is deleted.
  - `merge_place(conn, place_id: str, into_id: str) -> None`: both must be places. Refuses a merge into itself and refuses cycles (`ValueError`).
  - `unmerge_place(conn, place_id: str) -> None`: works on any id that has a merge row, whether or not the place still exists, and deletes the row when it has no name. An id without a merge row raises `ValueError`.
  - CLI subcommands: `places`, `routes`, `name-place ID NAME`, `name-route ID NAME`, `merge-place ID INTO`, `unmerge-place ID`. The two list commands print aligned columns.

- [ ] **Step 1: Write the failing tests**

```python
def test_name_place_then_refresh_uses_it(conn): ...  # name_source becomes "owner"
def test_empty_name_clears(conn): ...  # and the group_overrides row is deleted
def test_orphaned_name_can_be_cleared(conn): ...  # name on a place, hide its activities, refresh → orphaned; name_group(..., "") deletes the row, next refresh reports nothing
def test_naming_a_merged_place_names_the_target(conn): ...  # merge B into A; name_group("place", B, "X") → ValueError mentioning A
def test_merge_place_moves_activities_and_refuses_cycles(conn): ...
def test_unmerge_works_on_orphaned_merge(conn): ...  # merge into A, then A disappears → unmerge_place(B) deletes the row
def test_unknown_group_raises(conn): ...  # name, clear and unmerge on an id with no group and no row
def test_list_places_fallback_first(conn): ...
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_activity_cli.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions and subcommands. Each `work` commits before returning, and `writer.run`'s refresh applies the new names.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: owner names and merges for places and routes`

---

### Task 8: MCP `place` filter, `places` and `same_route`

**Files:**
- Modify: `ingest/mcp_server/filters.py`, `ingest/mcp_server/activities.py`, `ingest/mcp_server/server.py`, `ingest/mcp_server/guide.md`, `ingest/tests/mcp_fixture.py` (add hikes and their group rows: two hikes to a place "Slavnik" that form one route group, one hike to "Šmarna gora", and two places both named "Grmada" with one hike each; existing tests that count the fixture's activities are updated)
- Test: `ingest/tests/test_mcp_activities.py`, `ingest/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: the `places`, `route_groups` and `activity_groups` tables.
- Produces in `filters.py`:
  - `ActivityFilter.place: str | None = None`, the id or name asked for, and `ActivityFilter.place_ids: tuple[str, ...] | None = None`, filled only by `resolve_place`.
  - `NO_PLACES_YET = "this database has no places yet; they appear after the next write job"`
  - `has_group_tables(conn) -> bool`: `places`, `route_groups` and `activity_groups` all exist in `sqlite_master`.
  - `fold_name(s: str) -> str`: `unicodedata.normalize("NFD", s)`, combining marks dropped (`unicodedata.combining`), then `casefold()`. It folds the same way as the site's `normalizeName`, so "šmarna gora" and "smarna gora" both match "Šmarna gora". SQLite's `lower()` folds ASCII only and is not used.
  - `resolve_place(conn, f: ActivityFilter) -> ActivityFilter`
    - Returns `f` unchanged when `f.place` is None.
    - Otherwise reads `SELECT id, name FROM places` and matches in Python: the place whose id equals `f.place`, else every place whose `fold_name(name) == fold_name(f.place)`.
    - Returns `dataclasses.replace(f, place_ids=<sorted ids>)`.
    - Raises `ValueError(NO_PLACES_YET)` without the group tables, and `ValueError(f"no place {f.place!r}; the places tool lists them")` when nothing matches.
  - `where_sql(f)`: with `place_ids` set, adds `a.id IN (SELECT activity_id FROM activity_groups WHERE place_id IN (?, …))` and the rule `"place: {value}"`, or `"place: {value} ({n} places with that name)"` when `n > 1`. With `place` set and `place_ids` None it raises `RuntimeError`, since a caller skipped `resolve_place`.
- Produces in `activities.py`:
  - `list_activities` and `summarize` call `f = resolve_place(db.conn, f)` before `where_sql`. They run inside the server's `run`, so the lookup happens after a sync or reopen, and its `ValueError` becomes a `ToolError`.
  - `places(db) -> dict` returns `{"data": {"places": [{id, name, name_source, kind, ele, count}]}, "counted": counted(["visible activities only"], n)}`, sorted by count descending, then name. Without the group tables it raises `ValueError(NO_PLACES_YET)`.
  - `same_route(db, activity_id: str) -> dict` returns `{"data": {"route": {"id", "name"} | None, "activities": [rows shaped like list_activities rows]}, "counted": …}`, newest first and including the given activity. Without the group tables it raises `ValueError(NO_PLACES_YET)`; an unknown activity raises `ValueError("no activity <id>")`.
- `server.py`:
  - `list_activities` and `summarize` gain `place: str | None = None`, passed through `_filter`.
  - New tools `places()` and `same_route(activity_id: str)`, both `READ_ONLY`, called through `run`.
- `guide.md`:
  - "Which tool" gains: places → `places`, then `list_activities(place=…)`; "other times on this route" → `same_route`.
  - The tables section lists the new tables.
  - Place names are automatic, the `place` filter takes an id or a name (case and accents ignored), and it is preferred over `find_place` for summits the owner has reached.

- [ ] **Step 1: Write the failing tests**

```python
def test_place_filter_by_id_and_name(db): ...  # by Slavnik's id and by "Slavnik" → the fixture's two hikes to Slavnik
def test_place_filter_ignores_case_and_accents(db): ...  # "šmarna gora" and "smarna gora" both → the hike to "Šmarna gora"
def test_place_filter_rule_mentions_duplicates(db): ...  # "Grmada" → both hikes, rule "place: Grmada (2 places with that name)"
def test_unknown_place_points_to_places_tool(db): with pytest.raises(ValueError, match="places tool"): list_activities(db, ActivityFilter(place="Nowhere"))
def test_places_lists_counts(db): ...
def test_same_route_includes_self_newest_first(db): ...
def test_same_route_none_for_one_off(db): assert same_route(db, "run2")["data"]["route"] is None
def test_without_group_tables_says_no_places_yet(tmp_path): ...  # fixture copy with the three group tables dropped: places, same_route and list_activities(place="Slavnik") raise ValueError(NO_PLACES_YET); list_activities without a place still works
async def test_tools_registered(server): assert {"places", "same_route"} <= tool_names(server)
async def test_unknown_place_is_a_tool_error(server): ...  # list_activities(place="Nowhere") through the server → ToolError
```

- [ ] **Step 2: Run** `$PY -m pytest ingest/tests/test_mcp_activities.py ingest/tests/test_mcp_server.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4: Run** `$PY -m pytest ingest -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: MCP place filter, places and same_route`
