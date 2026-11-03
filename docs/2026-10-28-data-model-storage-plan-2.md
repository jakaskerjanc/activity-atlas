# v2 Data Plan 2: Garmin fetch re-checks, deletions and wellness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edits and deletions made in Garmin Connect reach the database. Every
Garmin activity file is fetched, indoor ones included. Garmin's daily wellness
data (monitoring FITs from the export, wellness endpoints from the API) is
archived and parsed into `daily_stats` and `daily_series`.

**Architecture:**
- **Re-check:** the daily fetch re-lists the last 30 days and compares each
  DTO with the stored one. A changed DTO re-downloads the file and writes a new
  source record. An activity missing from the re-check gets `deleted_at`
  through the existing `engine.mark_missing_deleted`.
- **Wellness inputs:** they get their own self-describing archive records
  (`WellnessRecord`). A new `ingest/wellness.py` turns them into per-day rows,
  recomputing each affected date from all of that date's inputs. Fetch, import
  and rebuild all share that one path.
- **Export recency:** records carry `as_of`, the time their data was observed.
  So an older export can no longer roll back newer data.

**Tech Stack:** Python 3.12, stdlib, the existing `fitdecode`. No new
dependencies.

**Spec:** `docs/2026-10-27-data-model-storage-design.md`. Plan 1
(`docs/2026-10-27-data-model-storage-plan-1.md`) is implemented on this branch;
this plan builds on its engine, archive and schema.

This is plan 2 of 4. Plan 3 is R2, sync, CI cutover and migration. Plan 4 is
display files and the app.

## Global Constraints

- **Branch:** keep working on `t3/data-model-dedupe-storage`. **Do not merge
  to `main` before Plan 3's cutover.** `main`'s daily fetch keeps running v1
  code.
- **Archive:** local folder only (`file://`). No R2, CI or display-build
  changes in this plan.
- **Re-check window:** `RECHECK_DAYS = 30`. "re-checks every activity that
  started in the last 30 days".
- **Wellness windows:**
  - Each run fetches "every day since the last stored day, plus the last 7
    days again": `WELLNESS_REVISE_DAYS = 7`.
  - With nothing stored, the first run goes back `WELLNESS_FIRST_DAYS = 30`
    days. `--wellness-since` overrides this for a backfill.
- **"Archive every original … untouched"**, including every API response. List
  pages and wellness responses are archived as the exact bytes received.
- **NULL is never 0.** A wellness value that no source reports stays NULL.
- **Wellness is stored, not published.** Nothing in this plan touches
  `scripts/` or `app/`.
- **IDs never change.** A re-check edit updates the activity in place.
- **The Garmin API client stays stdlib-only** (`ingest/garmin_api.py`).
- **Existing exit codes:** 2 (no key), 3 (key rejected), 4 (v1 database).

## Review Focus

The inputs most likely to hurt a real user that no happy-path test exercises.
Each one has a test in the task named.

1. **The re-check list comes back empty or short** (API glitch) → nothing is
   marked deleted when no listed activity falls inside the window, though
   stored ones do (Task 3).
2. **Manual activities have no file** (the download returns 404, or a ZIP
   without an activity file) → stored without a file. Not retried every run,
   and not counted toward the 3-failure stop (Task 3).
3. **The re-download of a changed activity fails** → the activity keeps its
   previous record, name and streams, and is not marked deleted (Task 3).
4. **An older export is imported after a newer one** → names don't roll back
   and deleted activities don't come back (Task 1).
5. **A wellness endpoint fails every day** (unsupported, 400/404) → the run
   stops calling that endpoint after 3 consecutive failures. Other endpoints
   and the activity fetch still complete. An auth error still exits 3 (Task 7).

---

### Task 1: Export recency (`as_of`)

Records are ordered by when their data was observed, not when it was imported.

**Files:**
- Modify: `ingest/records.py`, `ingest/archive.py` (`put_record`), `ingest/export_reader.py`, `ingest/strava_import.py`, `ingest/garmin_import.py`, `README.md` (Populating the database)
- Test: `ingest/tests/test_archive.py`, `ingest/tests/test_strava_import.py`, `ingest/tests/test_garmin_import.py`

**Interfaces:**
- Produces:
  - `SourceRecord.as_of: str | None = None` (new last field). An export's
    creation time as ISO UTC (`YYYY-MM-DDTHH:MM:SS+00:00`); `None` means "use
    `fetched_at`" (API records).
  - `records.recency(r: SourceRecord) -> tuple[str, str, str]` =
    `(r.as_of or r.fetched_at, r.fetched_at, r.content_sha())`.
  - `export_reader.export_made_at(path: str) -> str | None`.
  - `export_reader.newest_export_as_of(archive, provider: str) -> str | None`.

- [ ] **Step 1: Write the failing tests.**
  - `test_archive.py`:
    - `test_latest_prefers_as_of_over_fetched_at`: record A has
      `fetched_at="2026-10-27T10:00:00+00:00"` and `as_of="2026-10-01T00:00:00+00:00"`;
      record B has `fetched_at="2026-10-20T10:00:00+00:00"` and `as_of=None`.
      `latest([A, B]) == [B]`.
    - `test_record_without_as_of_keeps_plan1_hash`: the
      `content_sha()` of a record built with `as_of=None` equals the sha256 of
      the canonical JSON of its dict without `fetched_at` and without an
      `as_of` key. Also `from_json` of a Plan 1 JSON (no `as_of` key) loads
      with `as_of is None`.
    - `test_put_record_compares_with_newest_by_recency`: storing B and then A
      (A has an older `as_of`, a later `fetched_at` and different content)
      writes A. `latest(list_records())` is still B.
  - `test_strava_import.py`:
    - `_zip` gains `made=(2026, 1, 1, 0, 0, 0)` and writes every member with
      `zipfile.ZipInfo(name, date_time=made)`, so existing tests are
      deterministic.
    - `test_export_made_at_reads_newest_member_time`: members dated
      `(2026, 10, 19, 7, 0, 0)` and `(2026, 10, 20, 8, 0, 0)` give
      `"2026-10-20T08:00:00+00:00"`. A folder gives `None`.
    - `test_older_export_does_not_roll_back_or_undelete`:
      1. Import `e_old` (made `(2026,9,1,0,0,0)`, rows `111` named "Old",
         `222`, `333`).
      2. Import `e_new` (made `(2026,10,20,0,0,0)`, rows `111` named "Edited"
         and `333`), so `222` is marked deleted.
      3. Import `e_old` again, with a later `now` each time.
      4. Assert: the third import warns
         (`pytest.warns(UserWarning, match="older than an export already imported")`);
         activity `111` is named `"Edited"`; source `222` keeps its
         `deleted_at`.
  - `test_garmin_import.py`:
    - `test_older_garmin_export_marks_nothing_deleted`:
      - `_garmin_zip` gains `made=` like `_zip`.
      - Import a newer export without the gym summary (gym marked deleted),
        then the older full export.
      - Assert: the gym stays deleted and the warning fires.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_archive.py ingest/tests/test_strava_import.py ingest/tests/test_garmin_import.py -q`.
  Expected: the new tests FAIL (`as_of` is an unexpected keyword; no
  `export_made_at`).

- [ ] **Step 3: Implement.**
  - **`SourceRecord`:**
    - `content_sha()` and `to_json()` omit the `as_of` key when it is `None`,
      so Plan 1 records keep their hash and bytes.
    - `latest()` and `LocalArchive.put_record`'s "newest stored" both use
      `recency`.
  - **`export_made_at`:**
    - The newest `ZipInfo.date_time` over all members, read as UTC.
    - `None` for a folder, or when every member date is `(1980, 1, 1, 0, 0, 0)`
      (zip's "no date").
  - **`newest_export_as_of`:** the max non-`None` `as_of` over
    `archive.list_records()` with `provider == provider` and
    `origin["kind"] == f"{provider}_export"`.
  - **Both importers:**
    1. Compute `made = export_made_at(path)` and
       `newest = newest_export_as_of(archive, provider)` before writing any
       record.
    2. Give every record `as_of=made`.
    3. When `made` and `newest` are both set and `made < newest`:
       - warn `f"{provider} export made {made} is older than an export already
         imported ({newest}): its records are archived but do not replace
         newer ones, and it marks nothing deleted"`;
       - skip `mark_missing_deleted`.
  - **README:** one sentence under Populating the database, saying an older
    export never replaces newer data.

- [ ] **Step 4: Run the whole Python suite.**
  Run: `.venv/bin/python -m pytest ingest/tests -q`. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: order source records by when their data was observed"`

---

### Task 2: Raw API response bytes

**Files:**
- Modify: `ingest/garmin_api.py`, `ingest/garmin_fetch.py` (`_list`)
- Test: `ingest/tests/test_garmin_api.py`, `ingest/tests/test_garmin_fetch.py`

**Interfaces:**
- Produces:
  - `GarminPersonalApi.get_raw(self, path: str, params: dict | None = None) -> bytes`:
    - sends `GET {base}{path}`, plus `?{urlencode(params)}` when `params` is
      given;
    - uses Bearer auth and `Accept: application/json`;
    - returns the body unchanged (`b""` for an empty body).
  - `GarminPersonalApi.list_activities_raw(self, start=0, limit=100) -> bytes`.
  - `garmin_api.parse_activity_list(body: bytes, url: str) -> list[dict]`
    holds today's JSON and list validation. `list_activities` becomes
    `parse_activity_list(self.list_activities_raw(...), url)`.
- Consumes: `GarminFetcher._list` from Plan 1.

- [ ] **Step 1: Write the failing tests.**
  - `test_garmin_api.py`:
    - `test_get_raw_builds_url_and_returns_body`:
      - `get_raw("/hrv-service/hrv/2026-10-27")` requests
        `https://api.test/hrv-service/hrv/2026-10-27`;
      - `get_raw("/wellness-service/wellness/dailyHeartRate", {"date": "2026-10-27"})`
        requests `…/dailyHeartRate?date=2026-10-27`;
      - both send a `Bearer jwt` header and return the opener's bytes
        unchanged.
    - `test_list_activities_raw_returns_bytes_unchanged`: the body
      `b'[ {"activityId": 1} ]'` comes back byte for byte.
    - The existing list tests keep passing.
  - `test_garmin_fetch.py`:
    - `FakeClient.list_activities_raw(start, limit)` returns
      `json.dumps(page, indent=1).encode()`.
    - `test_list_pages_are_archived_byte_for_byte`: the archived blob under
      each record's `origin["list_sha"]` equals those exact bytes.
    - Update `test_fetch_archives_list_page_zip_and_file` accordingly.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_api.py ingest/tests/test_garmin_fetch.py -q`.
  Expected: FAIL with no attribute `get_raw` / `list_activities_raw`.

- [ ] **Step 3: Implement.** `_list` calls `client.list_activities_raw`,
  archives the bytes as received, and parses them with `parse_activity_list`.
  Delete the "re-serialized" comment.

- [ ] **Step 4: Run the whole Python suite.** Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: archive Garmin API responses as the bytes received"`

---

### Task 3: Fetch re-check, deletions and every activity's file

**Files:**
- Modify: `ingest/garmin_fetch.py`, `README.md` (Live Garmin fetch)
- Test: `ingest/tests/test_garmin_fetch.py`

**Interfaces:**
- Consumes:
  - `engine.mark_missing_deleted(conn, provider, seen_ids, start, end, *, now) -> int`
  - `engine.apply_records`
  - `merge.iso`
- Produces:
  - `RECHECK_DAYS = 30`
  - `GarminFetcher.run() -> dict[str, int]` with keys `insert`, `update`,
    `merge`, `deleted` (Task 7 adds `wellness_days`)
  - `has_gps_hint` is deleted.

**Rules:**
- `cutoff_epoch = min(high_water_epoch, now_epoch - RECHECK_DAYS*86400)`. With
  no high-water mark, the cutoff is 0 (the full list, as today).
- Paging stops when a page's oldest start is `<= cutoff_epoch`.
- Each listed item with start `> cutoff_epoch`:
  - **Known and unchanged** (`json.loads(activity_sources.summary_json) == item`
    for `('garmin', str(activityId))`): no download, no record.
  - **New or changed:** download the activity ZIP.
    - **Success with an activity file:** write a record with the file.
    - **`GarminApiError` with `status == 404`, or a ZIP with no
      .fit/.tcx/.gpx (`ValueError`):** the activity has no file. Write a
      record without one. This is not a failure. An unchanged DTO then
      prevents a retry.
    - **`GarminAuthError`:** raise.
    - **Any other error:**
      - warn and count a consecutive failure;
      - write no record, so a known activity keeps its previous record and a
        new one is retried next run while it stays inside the window;
      - stop processing items after 3 consecutive failures (as today).
- **Deletion:**
  - `seen` = every listed item whose start falls in
    `[now - RECHECK_DAYS, now]`, whatever happened to its download.
  - Call `engine.mark_missing_deleted(conn, "garmin", seen, iso(now - 30 d), self.now, now=self.now)`
    **before** `apply_records`.
  - Skip it, with the warning `"re-check listed no Garmin activities in the
    last 30 days; marking nothing deleted"`, when `seen` is empty but a
    non-deleted Garmin source starts inside the window.

- [ ] **Step 1: Write the failing tests.**
  - `FakeClient(items, download)`: `download` may also be a dict
    `{activityId: bytes | Exception}`.
  - `NOW_IN = "2026-09-20T10:00:00+00:00"` puts both fixture activities
    (2026-09-11 and 2026-09-12) inside the window. Existing tests keep
    `now="2026-10-27…"`, which is outside it.
  - **Replace** the `has_gps_hint` tests and
    `test_legacy_has_polyline_signal_downloads_without_start_coordinates`
    with:
    - `test_run_downloads_every_new_activity_including_indoor`:
      `download_calls == [5000001, 5000002]`, and the gym is stored with the
      `indoor.fit` streams (`has_hr == 1`, `polyline == ""`).
  - Update `test_run_inserts_with_geometry_and_windows_on_rerun` and the
    other `run()` assertions to the new key set (`deleted: 0`) and the new
    download calls.
  - **New tests:**
    - `test_recheck_unchanged_dto_downloads_nothing`: two runs at `NOW_IN`
      with the same list. The second run has no downloads, writes no new
      record files, and returns `update == 0`.
    - `test_recheck_changed_dto_updates_in_place`: the second run's list
      renames `5000001` to `"Renamed"`. Exactly one download (`5000001`);
      same activity id; name `"Renamed"`; two record files for `5000001`.
    - `test_recheck_missing_activity_is_marked_deleted`: the second list
      lacks `5000002`. Its source gets `deleted_at == second now`, its
      activity `visible == 0`, and `run()["deleted"] == 1`.
    - `test_activity_outside_window_is_not_deleted`: first run at `NOW_IN`.
      The second run, at `"2026-11-30T10:00:00+00:00"` with an empty list,
      deletes nothing.
    - `test_empty_recheck_list_deletes_nothing` (Review Focus 1): the second
      run at `NOW_IN` returns an empty list. Nothing is deleted and the
      warning fires.
    - `test_manual_activity_without_file_is_stored_and_not_retried` (Review
      Focus 2):
      - three items without a file
        (`download = {id: GarminApiError("x", status=404)}`) plus one GPS
        item that succeeds, all inside the window;
      - all four are stored and the run doesn't stop;
      - a second run makes no downloads.
    - `test_failed_redownload_keeps_previous_record` (Review Focus 3):
      - the second run renames `5000001` and its download raises
        `RuntimeError`;
      - name unchanged, polyline unchanged, not deleted, one record file.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_fetch.py -q`.

- [ ] **Step 3: Implement** the rules above in `GarminFetcher`.
  - Replace the "missed once the high-water mark moves past it" comment: the
    re-check now retries inside the window.
  - **README Live Garmin fetch:**
    - the 30-day re-check;
    - edits update in place;
    - activities missing from the re-check are marked deleted (not removed);
    - every activity's file is downloaded, indoor included;
    - activities without a file are kept without streams.

- [ ] **Step 4: Run the whole Python suite.** Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: re-check the last 30 days of Garmin activities for edits and deletions"`

---

### Task 4: Monitoring FIT parser

**Files:**
- Create: `ingest/parse/monitoring.py`
- Test: `ingest/tests/test_parse.py`

**Interfaces:**
- Produces:
  ```python
  MONITORING_FILE_TYPES = ("monitoring_a", "monitoring_b", "monitoring_daily")

  @dataclass
  class MonitoringData:
      utc_offset_s: int | None                         # monitoring_info local_timestamp - timestamp
      series: dict[str, list[tuple[int, float]]]       # "hr" | "stress" | "respiration" -> [(unix_s, value)], time order
      resting: dict[str, dict]                         # local date -> {"resting_heart_rate": .., "current_day_resting_heart_rate": ..}

  def parse_monitoring(data: bytes) -> MonitoringData
  ```

**Rules** (verified on `fixtures/monitoring.fit`, Forerunner 265):
- **`hr`:** from `monitoring` messages with `heart_rate`. These carry only
  `timestamp_16`. Resolve it against the last full `timestamp` seen in any
  earlier data message, in FIT-epoch seconds:
  ```python
  FIT_EPOCH = 631065600            # 1989-12-31T00:00:00Z
  last = int(ts.timestamp()) - FIT_EPOCH
  t = last + ((ts16 - last) & 0xFFFF)
  unix_s = t + FIT_EPOCH
  ```
  Drop `heart_rate == 0` (no reading).
- **`stress`:** `stress_level.stress_level_value` at `stress_level_time`. Drop
  negative values (off-wrist or activity).
- **`respiration`:** `respiration_rate.respiration_rate` at `timestamp`. Drop
  negative values.
- **`resting`:** each `monitoring_hr_data` message, keyed by the local date of
  its timestamp (UTC plus `utc_offset_s`; UTC when the offset is unknown).

- [ ] **Step 1: Write the failing test.**
  `test_parse_monitoring_fixture`:
  - `utc_offset_s == 7200`;
  - `len(series["hr"]) == 193`, `series["hr"][0] == (unix("2026-04-10T22:25:00Z"), 74)`,
    `series["hr"][-1] == (unix("2026-04-11T03:30:00Z"), 58)`;
  - `len(series["stress"]) == 304`, first `(unix("2026-04-10T22:25:00Z"), 31)`;
  - `len(series["respiration"]) == 305`, first `(unix("2026-04-10T22:26:00Z"), 18.58)`;
  - `resting == {"2026-04-11": {"resting_heart_rate": 57, "current_day_resting_heart_rate": 59}}`.

  Also assert `parse_fit(io.BytesIO(data), geometry=False).file_type in MONITORING_FILE_TYPES`.

- [ ] **Step 2: Run it and see it fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_parse.py -q -k monitoring`.

- [ ] **Step 3: Implement `parse_monitoring`** with `fitdecode`, reading
  messages in file order.

- [ ] **Step 4: Run it and see it pass.**

- [ ] **Step 5: Commit.** `git commit -m "feat: parse all-day HR, stress and respiration from monitoring FITs"`

---

### Task 5: Wellness records, schema v3 and per-day recompute

**Files:**
- Create: `ingest/wellness.py`
- Modify: `ingest/records.py`, `ingest/archive.py`, `ingest/codec.py`, `ingest/db.py`, `ingest/rebuild.py`
- Test: create `ingest/tests/test_wellness.py`; modify `test_archive.py`, `test_codec.py`, `test_db.py`, `test_rebuild.py`

**Interfaces:**
- Consumes: `parse_monitoring`, `MonitoringData` (Task 4).
- Produces:
  ```python
  # records.py
  @dataclass(frozen=True)
  class WellnessRecord:
      provider: str        # "garmin"
      source: str          # "monitoring_fit" | an endpoint name (Task 7)
      key: str             # monitoring_fit: the file's sha256; API: the calendar date YYYY-MM-DD
      fetched_at: str
      blob_sha256: str
      file_name: str | None
      origin: dict         # {"kind": "garmin_export" | "garmin_api", ...}
      def content_sha(self) -> str      # everything except fetched_at
      def to_json(self) -> bytes
      @staticmethod
      def from_json(data: bytes) -> "WellnessRecord"
  def latest_wellness(records) -> list[WellnessRecord]   # newest per (provider, source, key); tie -> larger content_sha

  # archive.py (and the Archive Protocol)
  def put_wellness(self, rec: WellnessRecord) -> bool    # skips when the newest stored has the same content_sha
  def list_wellness(self) -> list[WellnessRecord]
  # layout: wellness/<provider>/<source>/<key>/<YYYYMMDDTHHMMSSZ>-<content_sha[:12]>.json

  # codec.py
  SERIES_SCALES = {"stress": 1, "respiration": 100}     # "hr" and "time" come from CHANNEL_SCALES
  # encode/decode accept any channel in CHANNEL_SCALES or SERIES_SCALES

  # wellness.py
  @dataclass
  class DayPart:
      stats: dict[str, float | str | None]               # daily_stats column -> value
      raw: object | None                                 # goes into daily_stats.raw[source]
      series: dict[str, list[tuple[int, float]]]         # channel -> [(unix_s, value)]
      utc_offset_s: int | None
  DayParser = Callable[[bytes, WellnessRecord], dict[str, DayPart]]   # local date -> part
  def register(source: str, parser: DayParser) -> None
  def apply_wellness(conn, archive, records: Iterable[WellnessRecord]) -> int   # number of dates recomputed
  ```

**Schema** (`SCHEMA_VERSION = 3`; an existing v2 database is rebuilt by
`open_for_write`, as in Plan 1):
- `daily_series` gains `utc_offset_s INTEGER` and `time BLOB`. `time` holds the
  seconds from local midnight, encoded as channel `"time"`; `data` holds the
  values, encoded as the row's channel.
- New table, derived and rebuilt with everything else:
  ```sql
  CREATE TABLE wellness_inputs (
    provider TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, date TEXT NOT NULL,
    blob_sha256 TEXT NOT NULL, file_name TEXT,
    PRIMARY KEY (provider, source, key, date));
  CREATE INDEX idx_wellness_inputs_date ON wellness_inputs(date);
  ```

**`apply_wellness` rules:**
1. **For each record:**
   - add a `raw_files` row: kind `"monitoring_fit"` for that source, else
     `"api_response"`; `provider_ref` = the key; `original_name` = `file_name`;
   - parse the blob with the registered parser;
   - replace that `(provider, source, key)`'s `wellness_inputs` rows with one
     per returned date;
   - the affected dates are the old dates plus the new ones.
   - A parser exception warns `f"unreadable wellness input {source} {key}: {e}"`
     and the record gets no inputs.
2. **For each affected date, ascending,** recompute the day from all of its
   `wellness_inputs` rows, ordered by `(provider, source, key)` and each
   parsed at most once per call:
   - **`daily_stats` columns:** the first non-`None` value over the inputs.
     Sources other than `"monitoring_fit"` go first, in source-name order,
     then `"monitoring_fit"`. Garmin's API daily figures beat our reading of
     a FIT.
   - **`raw`:** JSON `{source: part.raw}` for every part whose `raw` is not
     `None`. When several `monitoring_fit` inputs share a date, merge their
     dicts in key order.
   - **`daily_series`:** per channel, take the union of the samples over all
     parts. Sort by `(unix_s, value)` and keep the first sample per `unix_s`.
     - `time` = `unix_s + utc_offset_s − local midnight` of the date. Use the
       part's own offset; with no offset, use UTC midnight.
     - The row's `utc_offset_s` is the first input's offset.
     - Delete the date's old rows first. Write no row for an empty channel.
   - A date left with no inputs gets its `daily_stats` and `daily_series`
     rows deleted.
3. **Registered here:** `"monitoring_fit"` maps `parse_monitoring`. Each local
   date of its samples or resting entries becomes a `DayPart` with:
   - `stats={"resting_hr": current_day_resting_heart_rate}`;
   - `raw=` that date's resting dict;
   - the date's samples, and the file's offset.

   API sources register in Task 7 (wire a lazy import like `engine`'s
   `_MAPPER_MODULES`: `{"garmin_api": "ingest.garmin_wellness"}`, looked up
   when a record's `origin["kind"]` has no parser yet).
4. **Rebuild:** after `engine.apply_records`, call
   `wellness.apply_wellness(conn, archive, latest_wellness(archive.list_wellness()))`.

- [ ] **Step 1: Write the failing tests.**
  - `test_codec.py`: `test_respiration_round_trip`: `[18.58, None, 16.75]`
    survives encode and decode.
  - `test_archive.py`: `test_put_wellness_skips_identical_and_lists`. Same
    content with a later `fetched_at` returns `False`; changed content
    returns `True`; `list_wellness()` returns both stored records.
  - `test_db.py`: the user_version assertions use `db.SCHEMA_VERSION`, and
    `wellness_inputs` exists.
  - `test_wellness.py`, using a `monitoring_fit` record of the fixture (key
    and blob = its sha):
    - `test_monitoring_fit_fills_series_and_resting_hr`:
      - rows for `2026-04-11` and channels `hr`, `stress`, `respiration`
        with `sample_count` 193 / 304 / 305;
      - `decode("time", hr.time)[0] == 1500.0` (00:25 local) and
        `decode("hr", hr.data)[0] == 74`;
      - `utc_offset_s == 7200`;
      - `daily_stats.resting_hr == 59`, and
        `json.loads(raw)["monitoring_fit"] == {"resting_heart_rate": 57, "current_day_resting_heart_rate": 59}`;
      - the other `daily_stats` columns are `None`.
    - `test_duplicate_inputs_on_one_date_merge_without_duplicates`: the
      same bytes under a second key still give 193 HR samples.
    - `test_reapply_changes_nothing`: snapshots of `daily_stats`,
      `daily_series` and `wellness_inputs` are equal after a second
      `apply_wellness`.
    - `test_api_source_beats_monitoring_for_stats`: register a test source
      `"zz_test"` whose parser returns
      `{"2026-04-11": DayPart({"resting_hr": 55, "steps": 9000}, {"x": 1}, {}, None)}`.
      Then `resting_hr == 55`, `steps == 9000`, and `raw` has both keys.
    - `test_corrupt_input_warns_and_adds_nothing`.
  - `test_rebuild.py`: `test_rebuild_keeps_wellness_tables`: after applying
    a monitoring record and rebuilding, `daily_stats` and `daily_series` are
    identical.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests -q -k "wellness or codec or db or rebuild"`.

- [ ] **Step 3: Implement** the interfaces and rules above. Document the
  `daily_series` encoding in `wellness.py`'s docstring, and `SERIES_SCALES`
  in the codec docstring.

- [ ] **Step 4: Run the whole Python suite.** Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: store wellness inputs and recompute daily stats and series per date"`

---

### Task 6: Garmin import archives monitoring FITs

**Files:**
- Modify: `ingest/garmin_import.py`, `README.md` (Populating the database)
- Test: `ingest/tests/test_garmin_import.py`

**Interfaces:**
- Consumes: `MONITORING_FILE_TYPES`, `WellnessRecord`,
  `archive.put_wellness`, `wellness.apply_wellness`.
- Produces: `GarminImporter.run()` also returns `wellness_days`, the number of
  dates recomputed.

**Rules:**
- The FIT scan (today's `_fit_index`, renamed `_scan_fits`) returns the
  activity index plus a list of monitoring records.
- **Each FIT whose type is in `MONITORING_FILE_TYPES`:**
  - `sha = put_blob(raw)`;
  - record `WellnessRecord("garmin", "monitoring_fit", sha, self.now, sha, basename, {"kind": "garmin_export"})`,
    with no `export_key`, so re-importing or overlapping exports write no new
    record files;
  - `put_wellness` it.
- After activities are applied: `apply_wellness(conn, archive, monitoring_records)`.
- Per-day wellness JSON in the export is **not** parsed here. The export zip
  is archived whole; parsing waits for Measurement.

- [ ] **Step 1: Write the failing test.**
  - `_garmin_zip` gains `monitoring=False`. When true, it adds
    `DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip`
    containing `monitoring.fit`.
  - `test_import_stores_monitoring_fits_as_wellness`:
    - `run()["wellness_days"] == 1`;
    - the `daily_series` `hr` row for `2026-04-11` has `sample_count == 193`;
    - one wellness record file;
    - `raw_files` has a `monitoring_fit` row;
    - re-importing the same zip writes no new wellness record file and
      leaves the daily tables unchanged.
  - Existing assertions on `run()` gain `wellness_days: 0`.

- [ ] **Step 2: Run it and see it fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_import.py -q`.

- [ ] **Step 3: Implement.** README: the Garmin import also stores monitoring
  FITs (all-day HR, stress, respiration, resting HR) as wellness data, which
  is not published.

- [ ] **Step 4: Run the whole Python suite.** Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: import Garmin monitoring FITs as wellness data"`

---

### Task 7: Wellness endpoints in the daily fetch

**Files:**
- Create: `ingest/garmin_wellness.py`
- Modify: `ingest/garmin_fetch.py` (`run`, CLI), `README.md` (Live Garmin fetch)
- Test: create `ingest/tests/test_garmin_wellness.py`; modify `test_garmin_fetch.py`

**Interfaces:**
- Consumes: `client.get_raw` (Task 2), `WellnessRecord`, `put_wellness`,
  `wellness.register`, `DayPart`, `apply_wellness` (Task 5).
- Produces:
  ```python
  WELLNESS_REVISE_DAYS = 7
  WELLNESS_FIRST_DAYS = 30
  ENDPOINTS: dict[str, Callable[[str], tuple[str, dict | None]]]   # source -> date -> (path, params)
  def fetch_wellness(client, archive, conn, *, now: str, since: str | None = None,
                     delay_s: float = 1.0) -> list[WellnessRecord]
  ```
  `GarminFetcher(..., wellness_since: str | None = None)`. `run()` adds
  `wellness_days`. CLI: `--wellness-since YYYY-MM-DD`.

**Endpoints:** per-day calls, so each response belongs to one date. The paths
are verbatim from the `garmin/connect-personal-api-python` README.
| source | path, params |
|---|---|
| `daily_summary` | `/usersummary-service/v2/dailysummaries`, `{"startDate": d, "endDate": d}` |
| `sleep` | `/sleep-service/sleep/dailySleep`, `{"date": d}` |
| `hrv` | `/hrv-service/hrv/{d}` |
| `body_battery` | `/wellness-service/wellness/bodyBattery/reports/daily`, `{"startDate": d, "endDate": d}` |
| `stress` | `/usersummary-service/stats/stress/daily/{d}/{d}` |
| `steps` | `/usersummary-service/stats/steps/daily/{d}/{d}` |
| `heart_rate` | `/wellness-service/wellness/dailyHeartRate`, `{"date": d}` |
| `spo2` | `/wellness-service/wellness/daily/spo2acclimation/{d}` |
| `weight` | `/weight-service/weight/range/{d}/{d}`, `{"includeAll": "true"}` |

**Typed columns.** **Field names are unverified.** They follow the unofficial
`garminconnect` payloads, are mapped only when present, and are confirmed in
Measurement. The raw payload is always kept, so a corrected mapping only
needs a rebuild.
- `daily_summary`: the payload is a list (pick the entry whose `calendarDate`
  equals the date) or a dict.
  - `resting_hr` ← `restingHeartRate`
  - `steps` ← `totalSteps`
  - `stress_avg` ← `averageStressLevel`
  - `body_battery_high` ← `bodyBatteryHighestValue`
  - `body_battery_low` ← `bodyBatteryLowestValue`
- `sleep`:
  - `sleep_s` ← `dailySleepDTO.sleepTimeSeconds`
  - `sleep_score` ← `dailySleepDTO.sleepScores.overall.value`
- `hrv`:
  - `hrv_avg` ← `hrvSummary.lastNightAvg`
  - `hrv_status` ← `hrvSummary.status`
- `weight`: `weight_kg` ← `dateWeightList[0].weight / 1000` (grams)
- `spo2`: `spo2_avg` ← `averageSpO2`
- The other sources are raw only. No intraday series from the API in this
  plan: their shapes are unknown, and the raw responses are archived.

Each source registers a parser. The parser returns
`{rec.key: DayPart(stats, raw=payload, series={}, utc_offset_s=None)}`.
Invalid JSON warns and returns `{}`; the bytes stay archived.

**`fetch_wellness` rules:**
- **Dates:**
  - `last` = `MAX(date)` over `wellness_inputs` rows whose source is in
    `ENDPOINTS`;
  - `start` = `since`, else `last − WELLNESS_REVISE_DAYS`, else
    `today − WELLNESS_FIRST_DAYS`;
  - `end` = today, the UTC date of `now`; the range is inclusive and
    ascending.
  - Accepted cost: while no endpoint has returned data, every run fetches
    the full 30 days again.
- **Each date, each endpoint in table order:**
  - Call `client.get_raw(path, params)`, then `time.sleep(delay_s)`.
  - **Empty body:** skip.
  - **`GarminAuthError`:** raise.
  - **Other `GarminApiError`:** warn and count a consecutive failure for that
    endpoint. After 3, warn `f"wellness endpoint {source} failed 3 times in
    a row; skipping it this run"` and stop calling it.
  - **Success:**
    - reset that endpoint's count;
    - `sha = put_blob(body)`;
    - write `WellnessRecord("garmin", source, date, now, sha, None, {"kind": "garmin_api", "path": path})`
      with `put_wellness`, and return it.
- **`GarminFetcher.run`:**
  1. apply activities and commit;
  2. `apply_wellness(conn, archive, fetch_wellness(...))` and commit.

  So a wellness auth error after the activities still leaves them stored;
  `main` exits 3 as today.

- [ ] **Step 1: Write the failing tests.**
  - `FakeClient.get_raw(path, params)` records `(path, params)` and returns
    `self.wellness.get(path, b"")`. Values may be bytes, an `Exception`, or a
    callable taking `params`.
  - `test_garmin_wellness.py`:
    - `test_first_run_fetches_30_days_of_every_endpoint`:
      - `now="2026-10-27T10:00:00+00:00"`, everything empty;
      - dates `2026-09-27`…`2026-10-27` (31 days);
      - `len(calls) == 31 * 9`; first call
        `("/usersummary-service/v2/dailysummaries", {"startDate": "2026-09-27", "endDate": "2026-09-27"})`.
    - `test_next_run_refetches_last_7_days`: after a run stored
      `daily_summary` for `2026-10-27`, a run at `2026-10-29T…` fetches
      `2026-10-20`…`2026-10-29`.
    - `test_wellness_since_overrides_start`.
    - `test_daily_summary_maps_typed_columns_and_keeps_raw`:
      - payload `[{"calendarDate": "2026-10-27", "restingHeartRate": 52, "totalSteps": 12000}]`;
      - `resting_hr == 52`, `steps == 12000`, `stress_avg is None`;
      - `raw["daily_summary"]` equals the payload.
    - `test_revised_day_replaces_value`: a second run with
      `restingHeartRate` 50 for the same date gives `50`, with two record
      files for that key.
    - `test_failing_endpoint_is_skipped_after_three_failures` (Review Focus 5):
      - `hrv` raises `GarminApiError("x", status=400)`;
      - `hrv` is called exactly 3 times, and every other endpoint 31 times;
      - the warning fires.
    - `test_unparseable_body_is_archived_and_adds_nothing`.
  - `test_garmin_fetch.py`:
    - Existing `run()` assertions gain `wellness_days: 0` (the default
      `get_raw` returns `b""`, so nothing is stored).
    - `test_wellness_auth_error_keeps_activities` (Review Focus 5):
      `get_raw` raises `GarminAuthError`, so `run()` raises it, but both
      activities are in the database.
    - `main` with `--wellness-since 2026-10-01` passes it through (monkeypatch
      `GarminFetcher`, as in `test_auth_error_mid_run_exits_3`).

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_wellness.py ingest/tests/test_garmin_fetch.py -q`.

- [ ] **Step 3: Implement.** README Live Garmin fetch:
  - the wellness endpoints;
  - the windows (since the last stored day minus 7; 30 days on the first
    run);
  - `--wellness-since` for a backfill;
  - the field names are unverified until measured;
  - wellness is stored, never published.

- [ ] **Step 4: Run the whole Python suite and the Node tests.**
  - Run: `.venv/bin/python -m pytest ingest/tests -q` and `pnpm run test`.
    Expected: all pass. Node has nothing to change; this confirms it.

- [ ] **Step 5: Commit.** `git commit -m "feat: fetch Garmin wellness endpoints in the daily fetch"`

---

## Out of scope

- **Per-day wellness JSON inside the Garmin export.** The file names and date
  range are unknown until Measurement; the zip is archived whole.
- **Intraday series from the API** (dailyHeartRate, body battery, sleep
  stages): the payload shapes are unknown; the responses are archived.
- **R2, sync, CI cutover** (Plan 3); display files and the app (Plan 4).
- **Strava live fetch** (spec non-goal).

## Measurement hand-off (no code)

Run with the owner's key and fresh exports before Plan 3:
- **Wellness endpoints:**
  - each endpoint's status and payload for one recent date;
  - confirm or correct the typed-column field names in `garmin_wellness.py`;
  - find how far back each endpoint serves data, which sets the
    `--wellness-since` backfill.
- **Files from the activity download:**
  - what it returns for a manual activity: 404, an empty ZIP, or something
    else;
  - whether it returns a FIT for indoor activities.
- **DTO stability:** does an unchanged activity's list DTO stay byte-for-byte
  identical between runs? If a volatile field changes, the re-check
  re-downloads every activity daily: compare only the stable fields.
- **Export dates:** member dates inside real Strava and Garmin export zips,
  for `export_made_at`.
- **Monitoring FITs in the Garmin export:** count, date range, other file
  types, and whether `monitoring_a` / `monitoring_daily` parse.
