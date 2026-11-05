# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, read-only stdio MCP server that lets an LLM agent (Claude Code first) answer questions about the owner's activities and wellness with fixed definitions, location search and automatic sync from R2.

**Architecture:** A new package `ingest/mcp_server/`. Plain functions do the work (one module per concern, each tested directly against a fixture database); `server.py` only wires them to MCP tools and wraps every result in the `data` / `counted` / `as_of` envelope. Two SQLite connections to the same file: an internal read-only one for the tools, and a locked-down one for raw `query`. Sync reuses `writer.pull` / `writer.install` with the read-only R2 token.

**Tech Stack:** Python 3.12, `sqlite3`, official MCP Python SDK `mcp==2.3.0` (`from mcp.server.mcpserver import MCPServer`, `@server.tool()`, `server.run("stdio")`, async `server.call_tool(name, args)` / `server.list_tools()` for tests), existing `ingest.codec`, `ingest.writer`, `ingest.objstore`, `polyline`, pytest.

**Spec:** `docs/2026-11-04-mcp-server-design.md`

## Global Constraints

- The server never writes to the database or R2. Its only file writes are: replacing the database via `writer.install` during sync, and the place cache.
- Sync uses `store_from_env(read_only=True)` (`R2_RO_ACCESS_KEY_ID`, `R2_RO_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`). Without a complete RO set: never overwrite the local file; `as_of.sync = "no R2"`.
- Default activity set: `visible = 1`; hidden only with `include_hidden=True`.
- Periods use the **local** start date `substr(start_local, 1, 10)`; weeks start Monday.
- Pace/speed over a set = total moving time ÷ total distance over activities with `distance > 0` and `moving_time > 0`. Never a mean of per-activity paces.
- Avg HR over a set = `avg_hr` weighted by `moving_time`, over activities with both.
- Unknown values (NULL) are excluded and counted, never treated as 0. No hidden thresholds: minimum distance/duration are parameters and appear in `counted.rules`.
- Types are not grouped silently: `types=["Run"]` means only `Run`.
- `query` returns `daily_stats.raw`, `activity_sources.summary_json`, `activity_sources.reported` as NULL.
- Caps: list rows default 200 (max 1000); `query` rows default 200 (max 2000) and a 10 s time limit; samples/series default 500 points (max 2000). A result that was cut says so (`truncated: true`).
- Sync check on start and before a tool call when the last check is older than 3600 s; download only when the R2 etag differs from the local file's MD5 (verified 2026-11-04: R2's etag for `db/activities.sqlite` equals the MD5 of the file, quoted).
- Location: default radius 200 m (max 50 000 m). Geocoder: Nominatim `https://nominatim.openstreetmap.org/search` with `format=jsonv2`, `limit=5`, `extratags=1`, at most 1 request per second, `User-Agent: strava-on-maps-mcp/0.1 (+https://github.com/jakaskerjanc/strava-on-maps)`. Never the owner's email. Results cached in `<db dir>/mcp/places.json`.
- Do not name anything top-level `mcp` (shadows the SDK). No absolute home paths in committed files.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The database file is replaced by a sync while a connection is open** → the next call must read the new file (reopen both connections after `install`), never a stale handle or an error. Test in Task 7.
2. **A track that passes the point but whose bounding box only touches it after widening** (e.g. track just outside the radius on one side, box edge exactly at the radius) → included when within radius, excluded when not. Test in Task 5.
3. **An activity with GPS samples but `None` holes in lat/lon** (watch lost signal) → closest approach ignores the holes, no crash. Test in Task 5.
4. **A `query` that tries to escape**: `ATTACH`, `PRAGMA query_only=0`, `CREATE TEMP TABLE`, `WITH RECURSIVE` runaway → refused or stopped by the time limit with a clear error, connection still usable. Test in Task 1.
5. **Nominatim unreachable or rate-limited (HTTP 429)** → `find_place` returns an error message that tells the model to ask the user or use known coordinates; nothing cached. Test in Task 6.

---

## File Structure

```
ingest/mcp_server/
  __init__.py
  __main__.py      # argparse --db, builds ServerContext, runs stdio
  database.py      # Database: two read-only connections, reopen(), run_query()
  filters.py       # ActivityFilter + where_sql()
  activities.py    # list_activities, get_activity, summarize
  samples.py       # bucket_average, activity_samples, wellness_series
  daily.py         # wellness (daily_stats per day or period)
  geo.py           # haversine_m, closest_approach, activities_near
  places.py        # PlaceFinder (Nominatim + cache + rate limit)
  freshness.py     # Syncer, as_of()
  guide.md         # static guide text
  guide.py         # guide_text(db) = guide.md + live coverage
  server.py        # build_server(ctx) -> MCPServer, envelope()
ingest/tests/mcp_fixture.py        # build_fixture_db(path) -> path
ingest/tests/test_mcp_database.py
ingest/tests/test_mcp_activities.py
ingest/tests/test_mcp_samples.py
ingest/tests/test_mcp_geo.py
ingest/tests/test_mcp_places.py
ingest/tests/test_mcp_freshness.py
ingest/tests/test_mcp_server.py
```

Every tool function returns a plain dict `{"data": ..., "counted": {...}}` (no `as_of`); `server.envelope()` adds `as_of`. `counted` shape everywhere: `{"rules": [str], "included": int, "excluded": {reason: int}}`.

---

### Task 1: Fixture database, read-only connections and `query`

**Files:**
- Modify: `requirements.txt` (add `mcp==2.3.0`)
- Create: `ingest/mcp_server/__init__.py`, `ingest/mcp_server/database.py`, `ingest/tests/mcp_fixture.py`
- Test: `ingest/tests/test_mcp_database.py`

**Interfaces:**
- Produces: `build_fixture_db(path: str) -> str` — schema via `ingest.db.open_db`, then inserts (all times UTC+1 unless noted, offset 3600):
  - `run1` Run 2025-03-10, 10 000 m, moving 3000 s, elapsed 3100 s, avg_hr 150, gain 50, visible, track: straight line north from (46.0000, 14.0000) to (46.0900, 14.0000), 10 samples, time 0..2700, hr 140..158.
  - `run2` Run 2025-03-12, 5 000 m, moving 1500 s, avg_hr NULL, visible, no track.
  - `run3` Run 2026-01-01 local 00:30 (start_time `2025-12-31T23:30:00+00:00`), 8 000 m, moving 2400 s, avg_hr 140, visible.
  - `run_nomove` Run 2025-03-14, 3 000 m, moving_time NULL, avg_hr NULL, visible.
  - `walk1` Walk 2025-03-11, distance NULL, moving 600 s, visible.
  - `hidden1` Run 2025-03-15, visible=0.
  - `hike1` Hike 2024-09-10, 12 000 m, moving 18000 s, gain 1500, track passing within 14 m of (46.3783, 13.8369), with one `None` lat/lon hole mid-track.
  - `daily_stats` rows 2025-03-10..2025-03-16 (resting_hr 50..56, sleep_s 25200..28800, hrv_avg one NULL day), one row with `raw='{"secret":1}'`.
  - `daily_series` 2025-03-10 `hr` 720 samples (every 120 s from 0) and `activity_sources` row for `run1` with `summary_json='{"description":"private"}'`.
  Streams encoded with `ingest.codec.encode`, keyed by a fake `streams_sha256`. For activities with a track, `start_lat/start_lng`, `min_lat…max_lng`, `has_gps=1` and an encoded `polyline` are set from the track. Totals: 7 activities, 6 visible, 4 visible runs.
- Produces: `class Database(path: str)` with `.conn` (internal, `mode=ro`), `.query_conn` (locked down), `reopen() -> None`, `close() -> None`; `QueryError(Exception)`; `run_query(db: Database, sql: str, params: list | None = None, max_rows: int = 200) -> dict` returning `{"data": {"columns": [...], "rows": [[...]], "truncated": bool}, "counted": {"rules": [...], "included": n, "excluded": {}}}`.

- [ ] **Step 1: Add `mcp==2.3.0` to `requirements.txt`; `uv pip install -p .venv -r requirements.txt`.**

- [ ] **Step 2: Write the failing tests** (`tmp_path` fixture db per test)

```python
def test_query_returns_rows(db): r = run_query(db, "select id from activities order by id"); assert ["run1"] in r["data"]["rows"]
def test_query_caps_rows(db): r = run_query(db, "select id from activities", max_rows=2); assert len(r["data"]["rows"]) == 2 and r["data"]["truncated"]
def test_query_hard_cap(db): r = run_query(db, "select 1", max_rows=10**6); assert "max_rows capped at 2000" in r["counted"]["rules"]
def test_blocked_columns_read_as_null(db):
    assert run_query(db, "select raw from daily_stats where raw is not null")["data"]["rows"] == []
    assert run_query(db, "select summary_json from activity_sources")["data"]["rows"] == [[None]]
@pytest.mark.parametrize("sql", ["delete from activities", "attach database ':memory:' as x",
    "pragma query_only=0", "create temp table t(x)", "insert into activities(id) values('z')"])
def test_query_refuses_writes(db, sql):
    with pytest.raises(QueryError): run_query(db, sql)
    assert run_query(db, "select count(*) from activities")["data"]["rows"][0][0] == 7
def test_query_time_limit(db):
    with pytest.raises(QueryError, match="time limit"):
        run_query(db, "with recursive c(x) as (select 1 union all select x+1 from c) select count(*) from c")
def test_internal_conn_reads_raw(db): assert db.conn.execute("select count(raw) from daily_stats").fetchone()[0] >= 1
```

- [ ] **Step 3: Run** `.venv/bin/python -m pytest ingest/tests/test_mcp_database.py -q` — Expected: FAIL (module missing).

- [ ] **Step 4: Implement `database.py`.** Both connections open `file:<path>?mode=ro` with `uri=True`, `check_same_thread=False`. `query_conn`: `PRAGMA query_only=ON`; `set_authorizer` allowing only `SQLITE_SELECT`, `SQLITE_READ`, `SQLITE_FUNCTION`, `SQLITE_RECURSIVE`, returning `SQLITE_IGNORE` for `SQLITE_READ` on the three blocked `(table, column)` pairs and `SQLITE_DENY` otherwise; `set_progress_handler` aborting after 10 s wall time (check every 10 000 VM steps). Map `sqlite3.DatabaseError` to `QueryError` with the SQLite message; "interrupted" → message containing "time limit". Fetch `max_rows + 1` to set `truncated`.

- [ ] **Step 5: Run the tests** — Expected: PASS. Also `.venv/bin/python -m pytest ingest -q` still green.

- [ ] **Step 6: Commit** `feat: read-only database access and query for the MCP server`

---

### Task 2: Filters, `list_activities`, `get_activity`

**Files:**
- Create: `ingest/mcp_server/filters.py`, `ingest/mcp_server/activities.py`
- Test: `ingest/tests/test_mcp_activities.py`

**Interfaces:**
- Consumes: `Database`, `build_fixture_db`.
- Produces:
  - `@dataclass ActivityFilter(types: list[str] | None = None, date_from: str | None = None, date_to: str | None = None, name_contains: str | None = None, min_distance_m: float | None = None, max_distance_m: float | None = None, min_moving_s: float | None = None, has_hr: bool | None = None, has_gps: bool | None = None, include_hidden: bool = False)`; dates are inclusive local `YYYY-MM-DD`.
  - `where_sql(f: ActivityFilter) -> tuple[str, list, list[str]]` — SQL condition on table alias `a`, params, and the human rules for `counted.rules` (e.g. `"visible activities only"`, `"local start date 2025-01-01..2025-12-31"`, `"types: Run"`, `"distance >= 1000 m"`).
  - `list_activities(db, f: ActivityFilter, sort: str = "date_desc", limit: int = 200, offset: int = 0) -> dict`; `sort` in `date_desc|date_asc|distance_desc|moving_desc|gain_desc`; rows: `id, date_local, type, name, distance_km, moving_min, pace_min_km` (`M:SS` string when distance and moving time known, else null), `speed_kmh`, `gain_m`, `avg_hr`. `data.total` = matching count.
  - `get_activity(db, activity_id: str) -> dict` — all numeric `activities` columns plus `hr_zone_seconds`/`hr_zone_limits` parsed from JSON, `laps` (by `laps.file_sha256 = activities.streams_sha256`, ordered `lap_index`), `gear` (from `activity_gear`), `sources` (provider, provider_activity_id, url). Unknown id → `ValueError("no activity <id>")`.

- [ ] **Step 1: Write failing tests**

```python
def test_default_excludes_hidden(db): ids = ids_of(list_activities(db, ActivityFilter())); assert "hidden1" not in ids
def test_include_hidden(db): assert "hidden1" in ids_of(list_activities(db, ActivityFilter(include_hidden=True)))
def test_local_date_range(db):  # run3 starts 2025-12-31 UTC but 2026-01-01 local
    assert ids_of(list_activities(db, ActivityFilter(date_from="2026-01-01"))) == ["run3"]
def test_types_exact(db): assert set(ids_of(list_activities(db, ActivityFilter(types=["Hike"])))) == {"hike1"}
def test_rules_listed(db):
    r = list_activities(db, ActivityFilter(types=["Run"], min_distance_m=1000))
    assert "types: Run" in r["counted"]["rules"] and "distance >= 1000 m" in r["counted"]["rules"]
def test_pace_string(db): row = row_of(list_activities(db, ActivityFilter()), "run1"); assert row["pace_min_km"] == "5:00"
def test_limit_and_total(db): r = list_activities(db, ActivityFilter(), limit=2); assert len(r["data"]["rows"]) == 2 and r["data"]["total"] == 6
def test_get_activity_sources(db): assert get_activity(db, "run1")["data"]["sources"][0]["provider"] == "strava"
def test_get_activity_unknown(db):
    with pytest.raises(ValueError): get_activity(db, "nope")
```

(`ids_of` / `row_of` are small helpers in the test file; rows are dicts.)

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `filters.py` and the two functions. `name_contains` uses `instr(lower(a.name), lower(?)) > 0`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: list and get activities with shared filters`

---

### Task 3: `summarize`

**Files:**
- Modify: `ingest/mcp_server/activities.py`
- Test: `ingest/tests/test_mcp_activities.py`

**Interfaces:**
- Produces: `summarize(db, f: ActivityFilter, period: str = "year", by_type: bool = True) -> dict`; `period` in `week|month|year|all`. Bucket keys: week = Monday date `date(substr(start_local,1,10), '-6 days', 'weekday 1')`, month `YYYY-MM`, year `YYYY`, all `"all"`. Each row: `period, type (when by_type), count, distance_km, distance_known, moving_h, elapsed_h, gain_m, gain_known, pace_min_km, speed_kmh, pace_basis_count, avg_hr, hr_known`. `counted.excluded` reasons: `"no distance or moving time (pace)"`, `"no avg HR or moving time (HR)"`.

- [ ] **Step 1: Write failing tests**

```python
def test_pace_is_total_time_over_total_distance(db):
    r = summarize(db, ActivityFilter(types=["Run"], date_from="2025-03-01", date_to="2025-03-31"), period="month")
    row = r["data"]["rows"][0]
    # run1 3000 s/10 km + run2 1500 s/5 km = 4500 s / 15 km = 5:00; run_nomove excluded
    assert row["pace_min_km"] == "5:00" and row["pace_basis_count"] == 2 and row["count"] == 3
    assert r["counted"]["excluded"]["no distance or moving time (pace)"] == 1
def test_hr_weighted_by_moving_time(db):  # only run1 has HR in March
    row = summarize(db, ActivityFilter(types=["Run"], date_to="2025-03-31"), period="all")["data"]["rows"][0]
    assert row["avg_hr"] == 150 and row["hr_known"] == 1
def test_year_uses_local_date(db):
    years = {r["period"] for r in summarize(db, ActivityFilter(types=["Run"]), period="year")["data"]["rows"]}
    assert "2026" in years  # run3
def test_week_starts_monday(db):  # 2025-03-12 is a Wednesday
    rows = summarize(db, ActivityFilter(types=["Run"], date_from="2025-03-12", date_to="2025-03-12"), period="week")["data"]["rows"]
    assert rows[0]["period"] == "2025-03-10"
def test_unknown_distance_not_zero(db):
    row = summarize(db, ActivityFilter(types=["Walk"]), period="all")["data"]["rows"][0]
    assert row["count"] == 1 and row["distance_known"] == 0 and row["distance_km"] is None
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with one grouped SQL query (sums with `CASE WHEN … THEN … END` so NULLs drop out). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: summarize activities by period with fixed definitions`

---

### Task 4: Samples, wellness, wellness series

**Files:**
- Create: `ingest/mcp_server/samples.py`, `ingest/mcp_server/daily.py`
- Test: `ingest/tests/test_mcp_samples.py`

**Interfaces:**
- Produces:
  - `bucket_average(times: list[float], channels: dict[str, list[float | None]], every_s: float) -> tuple[list[float], dict[str, list[float | None]]]` — bucket start times and the mean of present values per bucket (None when a bucket has none).
  - `activity_samples(db, activity_id: str, channels: list[str] | None = None, every_s: float | None = None, max_points: int = 500) -> dict` — channels from `ingest.codec.CHANNEL_SCALES` minus `time`; default = every channel the stream has. `every_s` default = `max(1, ceil((last_t - first_t + 1) / max_points))` (the `+ 1` keeps the last sample inside `max_points` buckets; `wellness_series` uses the same rule); result `data = {"every_s", "columns": ["t_s", *channels], "rows": [...]}`, units in `data.units` (`altitude m, hr bpm, speed m/s, distance m, cadence rpm/spm, power W, temperature °C, lat/lon deg`). No stream → `data.rows == []` and `counted.excluded["no samples stored"] = 1`.
  - `wellness_series(db, date: str, channel: str, every_s: float | None = None, max_points: int = 500) -> dict` — decodes `daily_series` (time = seconds from local midnight); `data.columns = ["local_time", channel]` with `HH:MM` times; missing row → empty rows plus `data.coverage` = first/last date that channel has.
  - `wellness(db, date_from: str, date_to: str, metrics: list[str] | None = None, period: str = "day") -> dict` — numeric `daily_stats` columns discovered via `PRAGMA table_info` (exclude `date`, `raw`, `hrv_status`); `period=day` returns per-day values (plus `hrv_status`); otherwise per bucket `mean`, `min`, `max`, `days_with_value` for each metric, buckets as in Task 3. Unknown metric → `ValueError` listing valid ones.

- [ ] **Step 1: Write failing tests**

```python
def test_bucket_average_skips_none(): t, c = bucket_average([0,1,2,3], {"hr":[100,None,110,120]}, 2); assert c["hr"] == [100, 115]
def test_samples_capped(db): r = activity_samples(db, "run1", ["hr"], max_points=5); assert len(r["data"]["rows"]) <= 5
def test_samples_none_for_no_stream(db): assert activity_samples(db, "run2")["counted"]["excluded"]["no samples stored"] == 1
def test_series_downsampled(db): r = wellness_series(db, "2025-03-10", "hr", max_points=24); assert len(r["data"]["rows"]) == 24 and r["data"]["rows"][0][0] == "00:00"
def test_series_missing_day_reports_coverage(db): r = wellness_series(db, "2030-01-01", "hr"); assert r["data"]["rows"] == [] and r["data"]["coverage"]["last"] == "2025-03-10"
def test_wellness_period_counts_days(db):
    row = wellness(db, "2025-03-10", "2025-03-16", ["hrv_avg"], period="week")["data"]["rows"][0]
    assert row["hrv_avg"]["days_with_value"] == 6
def test_wellness_never_returns_raw(db): assert "raw" not in str(wellness(db, "2025-03-10", "2025-03-16"))
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: activity samples and wellness tools`

---

### Task 5: Geometry and `activities_near`

**Files:**
- Create: `ingest/mcp_server/geo.py`
- Test: `ingest/tests/test_mcp_geo.py`

**Interfaces:**
- Produces:
  - `haversine_m(lat1, lon1, lat2, lon2) -> float` (R = 6 371 000).
  - `closest_approach(lats: list[float | None], lons: list[float | None], lat: float, lon: float) -> tuple[float, int] | None` — minimum distance and sample index, skipping `None` pairs; None for no points. **This is the reusable seam for future place tags (spec "Room for place tags later"); keep it free of database code.**
  - `activities_near(db, lat: float, lon: float, radius_m: float = 200, mode: str = "route", f: ActivityFilter | None = None, limit: int = 50) -> dict` — `mode` in `route|start|end`. Prefilter on `min_lat/max_lat/min_lng/max_lng` widened by `radius_m / 111320` degrees of latitude and `radius_m / (111320 * cos(lat))` of longitude (`start` mode: on `start_lat/start_lng`). Exact check on decoded `streams` lat/lon; fall back to decoding `activities.polyline` (`polyline.decode`) when no stream lat/lon. Rows nearest first: `id, date_local, type, name, closest_m` (rounded to 1 m), `at_elapsed_s`, `at_local_time` (`HH:MM`, from `start_local` + stream time), `source` (`"stream"`/`"polyline"`). `counted.rules` includes the radius and mode.

- [ ] **Step 1: Write failing tests**

```python
def test_closest_approach_skips_holes(): assert closest_approach([46.0, None, 46.001], [14.0, None, 14.0], 46.001, 14.0)[1] == 2
def test_triglav_like(db): r = activities_near(db, 46.3783, 13.8369); assert ids_of(r) == ["hike1"] and r["data"]["rows"][0]["closest_m"] <= 20
def test_radius_edge(db):  # point 150 m east of run1's line: in at 200, out at 100
    lat, lon = 46.05, 14.0 + 150 / (111320 * math.cos(math.radians(46.05)))
    assert "run1" in ids_of(activities_near(db, lat, lon, 200)) and "run1" not in ids_of(activities_near(db, lat, lon, 100))
def test_start_mode(db): assert ids_of(activities_near(db, 46.0, 14.0, 50, mode="start")) == ["run1"]
def test_filters_apply(db): assert ids_of(activities_near(db, 46.3783, 13.8369, f=ActivityFilter(types=["Run"]))) == []
def test_radius_cap(db):
    with pytest.raises(ValueError): activities_near(db, 46.0, 14.0, 60000)
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: find activities whose route passes near a point`

---

### Task 6: `find_place`

**Files:**
- Create: `ingest/mcp_server/places.py`
- Test: `ingest/tests/test_mcp_places.py`

**Interfaces:**
- Produces: `class PlaceFinder(cache_path: str, fetch: Callable[[str, dict], list[dict]] | None = None, clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep)`; `find(query: str) -> dict` with `data.candidates = [{"name", "kind", "lat", "lon", "elevation_m", "country"}]` (kind = `f"{category}/{type}"`, elevation from `extratags.ele` when numeric, country from `display_name` last part) and `data.cached: bool`. Default `fetch` uses `urllib.request` with the URL, params and User-Agent from Global Constraints and a 10 s timeout. Cache: JSON dict keyed by `query.strip().lower()`, written atomically (temp file + `os.replace`), directory created on first write. Errors → `PlaceLookupError` whose message says the lookup failed and the model should ask the user or use coordinates it is sure of.

- [ ] **Step 1: Write failing tests** (fake `fetch`, fake clock/sleep; no network)

```python
def test_parses_candidates(tmp_path): r = PlaceFinder(str(tmp_path/"p.json"), fetch=fake_triglav).find("Triglav"); c = r["data"]["candidates"][0]; assert (c["kind"], c["elevation_m"]) == ("natural/peak", 2864)
def test_cached_second_time(tmp_path): f = counting_fetch(); pf = PlaceFinder(str(tmp_path/"p.json"), fetch=f); pf.find("Triglav"); assert pf.find(" triglav ")["data"]["cached"] and f.calls == 1
def test_rate_limited(tmp_path): sleeps = []; pf = PlaceFinder(..., clock=lambda: 0.0, sleep=sleeps.append); pf.find("a"); pf.find("b"); assert sleeps == [1.0]
def test_failure_not_cached(tmp_path):
    pf = PlaceFinder(str(tmp_path/"p.json"), fetch=raising_http_429)
    with pytest.raises(PlaceLookupError, match="ask the user"): pf.find("x")
    assert not (tmp_path/"p.json").exists()
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: look up place names with a cached Nominatim client`

---

### Task 7: Sync and freshness

**Files:**
- Create: `ingest/mcp_server/freshness.py`
- Test: `ingest/tests/test_mcp_freshness.py`

**Interfaces:**
- Consumes: `writer.DB_KEY`, `writer.pull`, `writer.install`, `writer.working_copy`, `ObjectStore` (`head`, `get`), `MemoryStore` in tests, `Database.reopen()`.
- Produces:
  - `class Syncer(db_path: str, store: ObjectStore | None, interval_s: float = 3600, clock: Callable[[], float] = time.time)` with `maybe_sync(force: bool = False) -> bool` (True when a new file was installed), `.last_check: float | None`, `.last_outcome: str` — one of `"up to date"`, `"downloaded"`, `"failed: <reason>"`, `"no R2"`, `"no database in R2"`. Skips the check when `not force` and `clock() - last_check < interval_s`. Compares `head(DB_KEY)["etag"].strip('"')` with the MD5 of the local file (missing file ≠ anything). Never raises on network errors.
  - `as_of(db: Database, syncer: Syncer) -> dict` — `{"newest_activity": max(start_local) of visible, "newest_wellness_day": max(daily_stats.date), "series_through": {channel: max(date)}, "last_sync_check": ISO UTC or null, "sync": last_outcome}`.

- [ ] **Step 1: Write failing tests** (MemoryStore; db files built with `build_fixture_db`)

```python
def test_no_store_never_overwrites(tmp_path): s = Syncer(path, None); assert not s.maybe_sync() and s.last_outcome == "no R2" and md5(path) == before
def test_up_to_date_skips_download(tmp_path): store.put(DB_KEY, open(path,"rb").read()); s = Syncer(path, spy(store)); s.maybe_sync(); assert s.last_outcome == "up to date" and store.get_calls == 0
def test_changed_downloads(tmp_path): store.put(DB_KEY, other_bytes); assert Syncer(path, store).maybe_sync() and open(path,"rb").read() == other_bytes
def test_interval_respected(tmp_path): t = [0.0]; s = Syncer(path, store, clock=lambda: t[0]); s.maybe_sync(); t[0] = 100; s.maybe_sync(); assert store.head_calls == 1
def test_failure_keeps_local(tmp_path): s = Syncer(path, failing_store); assert not s.maybe_sync() and s.last_outcome.startswith("failed:") and md5(path) == before
def test_reopen_reads_new_file(tmp_path):  # Review Focus 1
    db = Database(path); store.put(DB_KEY, bytes_with_extra_activity); Syncer(path, store).maybe_sync(); db.reopen()
    assert db.conn.execute("select count(*) from activities where id='extra'").fetchone()[0] == 1
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: sync the local database from R2 with the read-only token`

---

### Task 8: Guide, server wiring, entry point, README

**Files:**
- Create: `ingest/mcp_server/guide.md`, `ingest/mcp_server/guide.py`, `ingest/mcp_server/server.py`, `ingest/mcp_server/__main__.py`
- Modify: `README.md` (new section "Ask an LLM about your data (MCP)"), `CONTEXT.md` only if a new term is needed
- Test: `ingest/tests/test_mcp_server.py`

**Interfaces:**
- Consumes: every function above.
- Produces:
  - `guide_text(db: Database) -> str` — `guide.md` plus a live "Coverage" section (activity date range and count by type; `daily_stats` range; per-channel `daily_series` range). `guide.md` contains: the tables and the columns the tools expose with units (distance m, times s, speed m/s, elevation m, HR bpm, sleep_s s, weight kg, respiration breaths/min); the Global Constraints definitions verbatim (visible set, local dates, Monday weeks, pace, HR weighting, unknowns, no hidden thresholds, no type grouping); "prefer `summarize`/`list_activities`/`activities_near` over `query`, and say so when falling back to `query`"; "confirm place names with `find_place` before `activities_near`"; "every answer should state what was counted, from `counted`"; the three blocked columns and why; that stress/respiration series end 2026-09-05 because the Garmin API has none.
  - `@dataclass ServerContext(db: Database, syncer: Syncer, places: PlaceFinder)`.
  - `build_server(ctx: ServerContext) -> MCPServer` — `MCPServer(name="strava-on-maps", instructions=guide_text(ctx.db))`; tools `guide, sync, list_activities, get_activity, summarize, activity_samples, wellness, wellness_series, find_place, activities_near, query`, each with a one-paragraph docstring (the tool description the model sees) and flat keyword parameters (filter fields spelled out, not a nested object). Every tool first calls `ctx.syncer.maybe_sync()` and `ctx.db.reopen()` when it returns True, then returns `envelope(result, ctx)` = result plus `as_of`. `ValueError`/`QueryError`/`PlaceLookupError` become tool errors with their message. All tools carry `ToolAnnotations(readOnlyHint=True)` except `sync` and `find_place` (`openWorldHint=True`).
  - `__main__.py`: `main() -> None`, run as `python -m ingest.mcp_server --db PATH [--no-sync]`. Builds `Database(path)` (error and exit 2 when the file is missing and no R2 is configured), `Syncer(path, store_from_env(read_only=True))`, `PlaceFinder(os.path.join(os.path.dirname(path), "mcp", "places.json"))`; runs `maybe_sync(force=True)` once before serving unless `--no-sync`; then `build_server(ctx).run("stdio")`. Logs go to stderr only.

- [ ] **Step 1: Write failing tests**

```python
async def test_lists_all_tools(ctx): names = {t.name for t in (await build_server(ctx).list_tools())}; assert names == {"guide","sync","list_activities","get_activity","summarize","activity_samples","wellness","wellness_series","find_place","activities_near","query"}
async def test_every_result_has_as_of(ctx): r = await build_server(ctx).call_tool("summarize", {"types": ["Run"], "period": "year"}); assert "as_of" in structured(r) and "counted" in structured(r)
async def test_error_is_tool_error(ctx): r = await build_server(ctx).call_tool("get_activity", {"activity_id": "nope"}); assert r.isError
def test_guide_has_live_coverage(ctx): g = guide_text(ctx.db); assert "Run: 4" in g and "hr: 2025-03-10..2025-03-10" in g
def test_main_refuses_missing_db_without_r2(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", str(tmp_path / "missing.sqlite")])
    with pytest.raises(SystemExit) as e: main()
    assert e.value.code == 2
```

(`ctx` fixture: fixture db, `Syncer(path, None)`, `PlaceFinder` with fake fetch. The repo has no async pytest plugin: write the async tests as plain functions that call `asyncio.run(...)`. `structured(r)` returns `r.structuredContent`. Coverage lines in the guide use the format `<channel>: <first>..<last>` and `<Type>: <count>`.)

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `.venv/bin/python -m pytest ingest -q` and `pnpm test` — all PASS.
- [ ] **Step 5: README section.** Exact registration for the owner (paths are examples in the README, written with `<checkout>`):

```bash
claude mcp add --scope user strava-on-maps \
  -e PYTHONPATH=<checkout> \
  -- <checkout>/.venv/bin/python -m ingest.mcp_server --db <checkout>/data/activities.sqlite
```

plus the bare command for other MCP clients, the sync behaviour, what leaves the machine (conversation, place names to Nominatim), and that `.env` is read from `<checkout>/.env` (via `ingest.config`).

- [ ] **Step 6: Manual check against the real database.** Register as above with `<checkout>=/home/jakas/Projects/strava-on-maps` (user scope, not committed), start a fresh `claude` session, and ask: "Is my average running pace improving year over year?" Expected: moving pace 5:57 (2024) → 5:55 (2025) → 5:46 (2026) or close, with the counted runs listed. Then "Which hikes reached the Triglav summit?" Expected: 2024-09-10 "Triglav Sunrise 😎" and 2026-09-20 "Gorje Hiking". Then "What was my heart rate through the day on 2026-10-15?" Expected: a series, not an empty result.
- [ ] **Step 7: Commit** `feat: MCP server tools, guide and setup`

---

## Execution notes

- Run every Python command from the worktree root with `.venv/bin/python`.
- `ingest/tests/conftest.py` already strips `R2_*` and points `.env` at a missing file for every test; keep tests offline.
- The owner's real database is `/home/jakas/Projects/strava-on-maps/data/activities.sqlite`; open it read-only only, and only in Task 8 Step 6.
