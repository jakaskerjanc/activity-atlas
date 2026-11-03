# v2 Data Plan 1: Archive and full-resolution database (local)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Imports and the Garmin fetch archive every original in a local
archive. They then build the v2 SQLite database: per-provider sources, lossless
streams, laps, gear, merged display values and random activity IDs. The
database can be rebuilt from the archive with unchanged IDs.

**Architecture:** Every provider record becomes a self-describing
**source record** (the provider's summary verbatim, plus a pointer to its
activity-file blob), stored in the archive. One engine turns source records
into the database: parse file → normalize to `SourceActivity` → match →
recompute the activity. Imports, the fetch and rebuilds all run through that
same engine. Display values are recomputed from the stored source rows
whenever an activity's sources change.

**Tech Stack:** Python 3.12 (CI) and the local interpreter, stdlib `sqlite3` /
`zlib` / `zipfile` / `secrets` / `zoneinfo`, the existing `fitdecode` /
`gpxpy` / `polyline` / `pytest`, plus the new pinned `timezonefinder`.

**Spec:** `docs/2026-10-27-data-model-storage-design.md`

This is plan 1 of 4 for the spec. Later plans:

- **Plan 2:** Garmin fetch re-checks, deletions and wellness.
- **Plan 3:** R2, sync, CI cutover and migration.
- **Plan 4:** Display files and app.

Plan 1 uses only a local-folder archive. It does not touch CI, R2, the
display build or the app.

## Global Constraints

- **Branch:** work on a feature branch and **do not merge to `main` before
  Plan 3's cutover.** `main`'s daily fetch keeps running v1 code against the
  committed v1 database.
- **Archive location:** `ARCHIVE_URL`, default `file://data/archive`. Add
  `data/archive/` to `.gitignore`. Database path default stays
  `data/activities.sqlite`.
- **Activity ID:** 10 characters from `[a-z0-9]`, from `secrets`, unique,
  assigned once and never changed.
- **Stream encoding:** quantize with the channel scales in Task 1, delta-encode,
  pack as little-endian **int64**, then zlib. Missing samples use the sentinel
  `-(2**63)`.
  - Deviation from the spec (int32 / INT32_MIN): deltas are int64 so a jump
    across the antimeridian cannot overflow. Values themselves still fit in
    int32.
- **Matcher:**
  - Accept a match when the overlap is ≥ 50% of the shorter time range.
  - Fall back to ±180 s on start time when either side lacks an elapsed time.
  - Reject when both sides have GPS distance and the distances differ by more
    than 20%.
  - Two records from the same provider never merge.
- **Merge policy:**
  - Strava first, Garmin second, for every value.
  - A provider-reported number beats our calculation, and calculations only
    fill gaps.
  - Absent stays NULL, never 0.
  - Deleted sources never win, unless every source is deleted.
- **Calculations:**
  - **Time in zones:** a sample counts in zone `i` for the first `i` with
    `hr < limits[i]`, otherwise in zone `len(limits)`. Its duration is the gap
    to the next sample.
  - **Elevation:** hysteresis threshold 2.0 m.
  - **Means:** time-weighted.
  - **Ingest route:** 0.5 m Douglas–Peucker, then precision-5 polyline (the
    existing `normalize.simplify` / `normalize.encode`).
- **Activities kept in the database** (the build-tracks contract): `id`,
  `name`, `type`, `start_time`, `distance`, `moving_time`, `elevation_gain`,
  `polyline`.
- **Commands:** use `${PYTHON_BIN:-python3}`. Tests: `pnpm run test:py` must
  pass after every task.
- **Commit style:** concise conventional messages, e.g.
  `feat: add stream codec`.

## Review Focus

- **Strava CSV header names differ from the mapped list.** The importer must
  warn, naming every mapped header that is absent, never silently store NULL
  for all activities. Test in Task 7.
- **A corrupt or truncated activity file in an export.** Expect a warning, the
  activity stored without streams, and the import continuing. Test in Task 7.
- **A manual Strava entry with elapsed 0 or missing.** Expect no
  division-by-zero; the ±180 s fallback applies. Test in Task 6.
- **Re-running the same import, or rebuilding twice.** Expect no new record
  files, the same IDs and identical rows. Test in Tasks 7 and 10.
- **FIT records with no timestamp, or time going backwards** (device resets).
  Expect them to be skipped or kept in file order, and the codec to stay
  lossless on negative deltas. Test in Tasks 1 and 2.

---

### Task 1: Stream codec

**Files:**
- Create: `ingest/codec.py`
- Test: `ingest/tests/test_codec.py`

**Interfaces:**
- Produces:
  - `CHANNEL_SCALES: dict[str, float]` = `{"time": 1, "lat": 1e7, "lon": 1e7, "altitude": 10, "hr": 1, "cadence": 1, "speed": 1000, "distance": 100, "power": 1, "temperature": 1}`
  - `MISSING: int = -(2**63)`
  - `encode(channel: str, values: list[float | None]) -> bytes`
  - `decode(channel: str, blob: bytes) -> list[float | None]`
  - `ENCODING_VERSION = 1`

- [ ] **Step 1: Write the failing tests**

```python
import struct, zlib
import pytest
from ingest import codec

def test_round_trip_with_missing_and_negative_deltas():
    vals = [299.0, 298.4, None, 301.2, 120.0]
    assert codec.decode("altitude", codec.encode("altitude", vals)) == vals

def test_quantizes_to_channel_resolution():
    assert codec.decode("lat", codec.encode("lat", [46.051234567])) == [46.0512346]
    assert codec.decode("hr", codec.encode("hr", [112.4])) == [112.0]

def test_antimeridian_jump_does_not_overflow():
    vals = [-179.9, 179.9, -179.9]
    assert codec.decode("lon", codec.encode("lon", vals)) == vals

def test_empty_and_all_missing():
    assert codec.decode("hr", codec.encode("hr", [])) == []
    assert codec.decode("hr", codec.encode("hr", [None, None])) == [None, None]

def test_wire_format_is_zlib_int64_deltas_against_last_present_value():
    raw = zlib.decompress(codec.encode("time", [0, 1, None, 3]))
    assert struct.unpack("<4q", raw) == (0, 1, codec.MISSING, 2)

def test_unknown_channel_rejected():
    with pytest.raises(KeyError):
        codec.encode("vo2", [1.0])
```

- [ ] **Step 2: Run, expect FAIL** (`ModuleNotFoundError: ingest.codec`)

Run: `${PYTHON_BIN:-python3} -m pytest ingest/tests/test_codec.py -q`

- [ ] **Step 3: Implement `encode` / `decode` in `ingest/codec.py`**

- **Encode:** `q = round(v * scale)`. Element `i` is `MISSING` when absent;
  otherwise `q_i - prev`, where `prev` is the last present `q` (0 before the
  first). Pack with `struct.pack(f"<{n}q", ...)`, then `zlib.compress(…, 9)`.
- **Decode** reverses this and returns `q / scale`.
- Document the format in the module docstring. Plan 4's Node decoder will
  follow it.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** — `git add ingest/codec.py ingest/tests/test_codec.py && git commit -m "feat: add lossless stream codec"`

---

### Task 2: Parsers return full data

**Files:**
- Modify: `ingest/parse/__init__.py`, `ingest/parse/fit.py`,
  `ingest/parse/tcx.py`, `ingest/parse/gpx.py`
- Create: `ingest/parse/dispatch.py`
- Test: `ingest/tests/test_parse.py` (extend; all existing tests stay green)

**Interfaces:**
- Consumes: `codec.CHANNEL_SCALES` keys as the channel vocabulary.
- Produces, in `ingest/parse/__init__.py`:

```python
@dataclass
class ParsedFile:
    file_type: str | None = None          # FIT file_id.type; None for gpx/tcx
    sport: str | None = None
    sub_sport: str | None = None
    start_time: datetime | None = None    # tz-aware UTC
    utc_offset_s: int | None = None
    streams: dict[str, list[float | None]] = field(default_factory=dict)  # keys ⊆ CHANNEL_SCALES; "time" = s since start_time; all lists equal length
    summary: dict[str, float | None] = field(default_factory=dict)        # keys: elapsed_s, moving_s, distance_m, avg_hr, max_hr, avg_cadence, max_cadence, avg_power, max_power, elevation_gain_m, elevation_loss_m, calories, aerobic_te, anaerobic_te
    laps: list[dict] = field(default_factory=list)                         # keys: index, start_time (ISO UTC), elapsed_s, moving_s, distance_m, avg_hr, max_hr, avg_speed, elevation_gain_m, elevation_loss_m, avg_cadence, avg_power, trigger
    hr_zones: dict | None = None          # {"seconds": list[float], "limits": list[int]}
    @property
    def track(self) -> list[tuple[float, float]]: ...   # (lat, lon) where both present

ParsedTrack = ParsedFile   # existing imports keep working
```

- Also produces, in `ingest/parse/dispatch.py`:
  `parse_bytes(name: str, data: bytes) -> ParsedFile`. It dispatches on
  `.fit` / `.tcx` / `.gpx`, gunzips a trailing `.gz`, and raises `ValueError`
  for unsupported names.

- [ ] **Step 1: Write the failing tests** (append to `test_parse.py`)

```python
def _fit(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return parse_fit(f)

def test_fit_outdoor_streams_summary_zones_offset():
    p = _fit("outdoor.fit")
    assert set(p.streams) == {"time", "lat", "lon", "altitude", "hr", "cadence", "speed", "distance", "temperature"}
    assert len(p.streams["time"]) == 3673 and p.streams["time"][0] == 0.0
    assert p.streams["hr"][0] == 112 and p.streams["altitude"][0] == 299.0 and p.streams["cadence"][0] == 53
    s = p.summary
    assert (s["avg_hr"], s["max_hr"], s["calories"]) == (97, 135, 330)
    assert (s["elevation_gain_m"], s["elevation_loss_m"]) == (130, 125)
    assert s["distance_m"] == 4662.85 and s["elapsed_s"] == pytest.approx(3697.667)
    assert p.hr_zones == {"seconds": [1741.278, 1304.387, 652.002, 0.0, 0.0, 0.0, 0.0],
                          "limits": [97, 116, 136, 155, 175, 194]}
    assert p.utc_offset_s == 3600 and len(p.laps) == 1 and len(p.track) == 3673

def test_fit_indoor_has_hr_but_no_position():
    p = _fit("indoor.fit")
    assert set(p.streams) == {"time", "hr", "distance"} and len(p.streams["hr"]) == 1594
    assert p.track == [] and p.utc_offset_s == 7200 and p.summary["avg_hr"] == 95

TCX_HR = b'''<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Lap StartTime="2026-08-01T06:30:00Z"><TotalTimeSeconds>10</TotalTimeSeconds><DistanceMeters>30</DistanceMeters><Calories>5</Calories><AverageHeartRateBpm><Value>120</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>130</Value></MaximumHeartRateBpm><Track>
<Trackpoint><Time>2026-08-01T06:30:00Z</Time><AltitudeMeters>300.5</AltitudeMeters><HeartRateBpm><Value>110</Value></HeartRateBpm></Trackpoint>
<Trackpoint><Time>2026-08-01T06:30:10Z</Time><Position><LatitudeDegrees>46.051</LatitudeDegrees><LongitudeDegrees>14.501</LongitudeDegrees></Position><DistanceMeters>30</DistanceMeters><HeartRateBpm><Value>130</Value></HeartRateBpm><Cadence>80</Cadence></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>'''

def test_tcx_streams_keep_positionless_points_and_lap_summary():
    p = parse_tcx(io.BytesIO(TCX_HR))
    assert p.streams["time"] == [0.0, 10.0] and p.streams["hr"] == [110, 130]
    assert p.streams["altitude"] == [300.5, None] and p.streams["lat"] == [None, 46.051]
    assert p.track == [(46.051, 14.501)]
    assert (p.summary["elapsed_s"], p.summary["distance_m"], p.summary["calories"]) == (10, 30, 5)
    assert (p.summary["avg_hr"], p.summary["max_hr"]) == (120, 130)
    assert p.sport == "Biking" and len(p.laps) == 1

GPX_HR = b'''<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><trkseg>
<trkpt lat="46.05" lon="14.5"><ele>300</ele><time>2026-08-01T06:30:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>101</gpxtpx:hr><gpxtpx:cad>77</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="46.051" lon="14.501"><ele>301</ele><time>2026-08-01T06:30:05Z</time></trkpt>
</trkseg></trk></gpx>'''

def test_gpx_reads_extension_hr_and_cadence():
    p = parse_gpx(io.BytesIO(GPX_HR))
    assert p.streams["time"] == [0.0, 5.0] and p.streams["altitude"] == [300.0, 301.0]
    assert p.streams["hr"] == [101, None] and p.streams["cadence"] == [77, None]

def test_dispatch_gunzips_and_matches_direct_parse():
    import gzip
    from ingest.parse.dispatch import parse_bytes
    raw = open(os.path.join(FIX, "outdoor.fit"), "rb").read()
    assert len(parse_bytes("a.fit.gz", gzip.compress(raw)).streams["hr"]) == 3673
    with pytest.raises(ValueError):
        parse_bytes("a.csv", b"x")

def test_fit_record_without_timestamp_is_skipped(monkeypatch):
    ...  # feed parse_fit a stream where one record lacks timestamp (build with fitdecode-free stub: monkeypatch fitdecode.FitReader to yield fake frames); assert the streams length excludes it
```

The last test's stub: monkeypatch `ingest.parse.fit.fitdecode.FitReader` with
a context manager. It should yield objects that pass the
`isinstance(frame, fitdecode.FitDataMessage)` check (monkeypatch that class
too) and have `name == "record"`, a `fields` list and `get_value`.

- [ ] **Step 2: Run, expect FAIL** on the new tests.

- [ ] **Step 3: Implement**

- **FIT:**
  - Records: `timestamp` → `time`; `position_lat` / `position_long`
    (semicircles × 180/2³¹) → `lat` / `lon`; `enhanced_altitude`, otherwise
    `altitude` → `altitude`; `heart_rate` → `hr`; `cadence`;
    `enhanced_speed`, otherwise `speed` → `speed`; `distance`; `power`;
    `temperature`.
  - Drop channels that have no values. Skip records without a timestamp.
  - `session` → `summary`: `total_elapsed_time`, `total_timer_time`,
    `total_distance`, `avg_heart_rate`, `max_heart_rate`, `avg_cadence`,
    `max_cadence`, `avg_power`, `max_power`, `total_ascent`,
    `total_descent`, `total_calories`, `total_training_effect`,
    `total_anaerobic_training_effect`.
  - `lap` messages → `laps`.
  - The `time_in_zone` message with `reference_mesg == "session"` → `hr_zones`
    (`time_in_hr_zone`, `hr_zone_high_boundary`).
  - `activity.local_timestamp − activity.timestamp` → `utc_offset_s`.
  - Keep `geometry=False` as the cheap `file_id` read.
- **TCX:** every `Trackpoint` with a `Time`.
  - Fields: `AltitudeMeters`, `DistanceMeters`, `HeartRateBpm/Value`,
    `Cadence`, and `Extensions` (ns
    `http://www.garmin.com/xmlschemas/ActivityExtension/v2`) `TPX/Speed` /
    `TPX/Watts`.
  - Summary is aggregated from `Lap`: sums of time, distance and calories; max
    of `MaximumHeartRateBpm`; time-weighted mean of `AverageHeartRateBpm`.
- **GPX:** read `ele` and `time`, and extensions by local tag name: `hr`, `cad`,
  `atemp` → `temperature`, `power`. No summary and no laps.

- [ ] **Step 4: Run `pnpm run test:py`, expect PASS** (the old `.track`-based
  tests included).

- [ ] **Step 5: Commit** — `feat: parse full streams, summaries, laps and zones`

---

### Task 3: Local archive and source records

**Files:**
- Create: `ingest/archive.py`, `ingest/records.py`
- Modify: `.gitignore` (add `data/archive/`)
- Test: `ingest/tests/test_archive.py`

**Interfaces:**
- Produces, in `ingest/records.py`:

```python
@dataclass(frozen=True)
class SourceRecord:
    provider: str                 # "strava" | "garmin"
    provider_activity_id: str
    fetched_at: str               # ISO-8601 UTC, seconds
    summary: dict                 # provider record verbatim (CSV row / JSON entry / API DTO)
    file_sha256: str | None       # blob of the decompressed activity file
    file_name: str | None         # e.g. "123.fit" (no .gz)
    origin: dict                  # {"kind": "strava_export"|"garmin_export"|"garmin_api", ...refs}
    def content_sha(self) -> str: ...      # sha256 of canonical JSON of every field except fetched_at
    def to_json(self) -> bytes: ...
    @staticmethod
    def from_json(data: bytes) -> "SourceRecord": ...

def latest(records: Iterable[SourceRecord]) -> list[SourceRecord]  # newest fetched_at per (provider, id); tie → larger content_sha
```

- Produces, in `ingest/archive.py`:

```python
class Archive(Protocol):
    def put_blob(self, data: bytes) -> str: ...            # sha256 hex; no-op if present
    def get_blob(self, sha256: str) -> bytes: ...          # KeyError if absent
    def has_blob(self, sha256: str) -> bool: ...
    def put_export(self, provider: str, src_path: str, *, today: str) -> str: ...   # key "exports/<provider>/<today>-<basename>"
    def put_record(self, rec: SourceRecord) -> bool: ...   # False when the latest stored record for (provider, id) has the same content_sha
    def list_records(self) -> list[SourceRecord]: ...

class LocalArchive:  # implements Archive under a root dir
    def __init__(self, root: str): ...

def open_archive(url: str | None = None) -> Archive   # url → env ARCHIVE_URL → "file://data/archive"; non-file schemes raise ValueError (r2:// arrives in Plan 3)
```

- Layout under the root:
  - `raw/<sha256>`
  - `exports/<provider>/<YYYY-MM-DD>-<name>`
  - `records/<provider>/<provider_activity_id>/<fetched_at as YYYYMMDDTHHMMSSZ>-<content_sha[:12]>.json`
- The `records/` prefix refines the spec's R2 layout so rebuilds can list
  their inputs. Plan 3 adds it to the R2 bucket.

- [ ] **Step 1: Write the failing tests**

```python
from ingest.archive import LocalArchive, open_archive
from ingest.records import SourceRecord, latest

def _rec(fetched_at="2026-10-27T10:00:00+00:00", name="Run"):
    return SourceRecord("garmin", "900", fetched_at, {"activityName": name}, None, None, {"kind": "garmin_api"})

def test_blobs_are_content_addressed_and_idempotent(tmp_path):
    a = LocalArchive(str(tmp_path))
    sha = a.put_blob(b"fit-bytes")
    assert a.put_blob(b"fit-bytes") == sha and a.get_blob(sha) == b"fit-bytes"
    assert len(list((tmp_path / "raw").iterdir())) == 1

def test_put_export_is_byte_identical(tmp_path):
    src = tmp_path / "export_123.zip"; src.write_bytes(b"PK\x03\x04zip")
    a = LocalArchive(str(tmp_path / "arch"))
    key = a.put_export("strava", str(src), today="2026-10-27")
    assert key == "exports/strava/2026-10-27-export_123.zip"
    assert (tmp_path / "arch" / key).read_bytes() == b"PK\x03\x04zip"

def test_put_record_skips_unchanged_but_keeps_a_b_a_edits(tmp_path):
    a = LocalArchive(str(tmp_path))
    assert a.put_record(_rec()) is True
    assert a.put_record(_rec("2026-10-28T10:00:00+00:00")) is False        # same content
    assert a.put_record(_rec("2026-10-29T10:00:00+00:00", "Renamed")) is True
    assert a.put_record(_rec("2026-10-30T10:00:00+00:00", "Run")) is True  # back to A is a change
    assert [r.summary["activityName"] for r in latest(a.list_records())] == ["Run"]

def test_record_json_round_trip():
    r = _rec()
    assert SourceRecord.from_json(r.to_json()) == r

def test_open_archive_defaults_and_rejects_unknown(monkeypatch, tmp_path):
    monkeypatch.setenv("ARCHIVE_URL", f"file://{tmp_path}")
    assert isinstance(open_archive(), LocalArchive)
    with pytest.raises(ValueError):
        open_archive("s3://x")
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Write each file to a temp name and `os.replace`
  it, so an interrupted run never leaves a partial blob.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat: add local content-addressed archive and source records`

---

### Task 4: v2 schema and `SourceActivity`

**Files:**
- Create: `ingest/db.py`
- Modify: `ingest/model.py` (add `SourceActivity` and `REPORTED_KEYS`; leave
  `RawActivity` / `Activity` until Task 9)
- Test: `ingest/tests/test_db.py`

**Interfaces:**
- Produces, in `ingest/model.py`:

```python
REPORTED_KEYS = ("avg_hr", "max_hr", "avg_cadence", "max_cadence", "avg_power", "max_power",
                 "elevation_gain_m", "elevation_loss_m", "calories", "aerobic_te", "anaerobic_te")

@dataclass
class SourceActivity:
    provider: str
    provider_activity_id: str
    name: str
    type: str                       # canonical (normalize.canonical_type)
    start_time: datetime            # tz-aware UTC
    elapsed_s: float | None
    moving_s: float | None
    distance_m: float | None
    utc_offset_s: int | None
    reported: dict[str, float | None]     # REPORTED_KEYS; provider summary first, then file summary
    hr_zones: dict | None
    gear: list[str]
    summary: dict                   # provider record verbatim
    file_sha256: str | None
    parsed: "ParsedFile | None"
    fetched_at: str
```

- Produces, in `ingest/db.py`:
  - `SCHEMA_VERSION = 2`
  - `connect(path) -> sqlite3.Connection` (with `row_factory = sqlite3.Row`)
  - `init_schema(conn) -> None`, which sets `PRAGMA user_version`
  - `open_db(path) -> sqlite3.Connection`. It initializes an empty file and
    returns a current one. It raises `SchemaMismatch` for a v1 database (an
    `activities` table and `user_version == 0`) and `NeedsRebuild` when
    `0 < user_version < SCHEMA_VERSION`.
  - Exceptions `SchemaMismatch` and `NeedsRebuild`.
- Tables. **(K)** marks state kept across rebuilds:
  - **`activities`:**
    - `id` (PK), `name`, `type`, `start_time`, `end_time`, `utc_offset_s`,
      `start_local`
    - `elapsed_time`, `moving_time`, `distance`
    - `elevation_gain`, `elevation_loss`
    - `avg_hr`, `max_hr`, `avg_cadence`, `max_cadence`, `avg_power`,
      `max_power`
    - `calories`, `aerobic_te`, `anaerobic_te`
    - `hr_zone_seconds` (JSON), `hr_zone_limits` (JSON)
    - `polyline` (NOT NULL DEFAULT ''), `start_lat`, `start_lng`
    - `min_lat`, `min_lng`, `max_lat`, `max_lng`
    - `has_gps`, `has_hr`, `has_altitude`, `has_cadence`, `has_power`
      (INTEGER NOT NULL DEFAULT 0)
    - `meta_provider`, `streams_sha256`
    - `calculated` (JSON list, DEFAULT '[]')
    - `visible` (INTEGER NOT NULL DEFAULT 1)
    - Indexes on `start_time` and `end_time`.
  - **`activity_sources`:**
    - (K) `provider`, `provider_activity_id`, `activity_id`, `pinned`,
      `deleted_at`
    - Derived: `url`, `name`, `type`, `start_time`, `end_time`,
      `elapsed_time`, `moving_time`, `distance`, `utc_offset_s`,
      `reported` (JSON), `hr_zones` (JSON), `file_sha256`, `gear` (JSON),
      `summary_json`, `fetched_at`, `first_seen`, `updated_at`
    - PK (`provider`, `provider_activity_id`); index on `activity_id`.
  - **`activity_overrides`** (K): `activity_id` (PK), `hidden`.
  - **`streams`:**
    - `file_sha256` (PK), `sample_count`, `encoding`, `distance_calculated`
    - one BLOB per `CHANNEL_SCALES` key
  - **`laps`:** PK (`file_sha256`, `lap_index`), plus the `ParsedFile.laps`
    keys.
  - **`gear`:** PK (`provider`, `name`), plus `kind`.
  - **`activity_gear`:** PK (`activity_id`, `provider`, `gear_name`).
  - **`daily_stats`:**
    - `date` (PK), `resting_hr`, `hrv_avg`, `hrv_status`
    - `sleep_s`, `sleep_score`, `steps`, `stress_avg`
    - `body_battery_high`, `body_battery_low`
    - `weight_kg`, `spo2_avg`, `raw` (JSON)
    - Created empty; Plan 2 fills it.
  - **`daily_series`:** PK (`date`, `channel`), plus `sample_count`,
    `encoding`, `data`. Created empty.
  - **`raw_files`:** `sha256` (PK), `kind`, `provider`, `provider_ref`,
    `original_name`, `size`, `fetched_at`.
- Streams and laps are keyed by **file hash**. So the identical FIT that
  Strava and Garmin both hold is stored once, and changing an activity's
  winner needs no archive access. This refines the spec's "one row per
  activity".

- [ ] **Step 1: Write the failing tests**

```python
from ingest import db

def test_init_sets_version_and_tables():
    conn = db.connect(":memory:"); db.init_schema(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"activities", "activity_sources", "activity_overrides", "streams", "laps", "gear",
            "activity_gear", "daily_stats", "daily_series", "raw_files"} <= names

def test_activities_keeps_build_tracks_columns():
    conn = db.connect(":memory:"); db.init_schema(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(activities)")}
    assert {"id", "name", "type", "start_time", "distance", "moving_time", "elevation_gain", "polyline"} <= cols

def test_open_db_rejects_v1(tmp_path):
    p = tmp_path / "v1.sqlite"
    c = db.connect(str(p)); c.execute("CREATE TABLE activities (id TEXT PRIMARY KEY)"); c.commit(); c.close()
    with pytest.raises(db.SchemaMismatch):
        db.open_db(str(p))

def test_open_db_flags_older_v2(tmp_path):
    p = tmp_path / "old.sqlite"
    c = db.connect(str(p)); db.init_schema(c); c.execute("PRAGMA user_version = 1"); c.commit(); c.close()
    with pytest.raises(db.NeedsRebuild):
        db.open_db(str(p))

def test_open_db_initialises_new_file(tmp_path):
    conn = db.open_db(str(tmp_path / "new.sqlite"))
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat: add v2 schema and SourceActivity`

---

### Task 5: Calculations and activity recompute

**Files:**
- Create: `ingest/calc.py`, `ingest/merge.py`
- Modify: `requirements.txt` (pin `timezonefinder` to the newest release
  that installs on Python 3.12 and on the local interpreter)
- Test: `ingest/tests/test_calc.py`, `ingest/tests/test_merge.py`

**Interfaces:**
- Consumes: `codec`, `ParsedFile`, `db`, `SourceActivity`, and
  `normalize.simplify` / `normalize.encode`.
- Produces, in `ingest/calc.py`:
  - `time_weighted_mean(t: list[float|None], v: list[float|None]) -> float | None`
  - `series_max(v: list[float|None]) -> float | None`
  - `elevation_gain_loss(alt: list[float|None], threshold_m: float = 2.0) -> tuple[float, float]`
  - `time_in_zones(t: list[float|None], hr: list[float|None], limits: list[int]) -> list[float]`
    — returns `len(limits) + 1` values
  - `cumulative_distance(lat: list[float|None], lon: list[float|None]) -> list[float|None]`
    — haversine, metres
  - `bbox(lat, lon) -> tuple[float, float, float, float] | None`
    — `(min_lat, min_lng, max_lat, max_lng)`
  - `local_offset_s(lat: float, lon: float, when_utc: datetime) -> int | None`
    — timezonefinder + `zoneinfo`
- Produces, in `ingest/merge.py`:
  - `source_url(provider: str, provider_activity_id: str) -> str`
  - `write_file_data(conn, file_sha256: str, parsed: ParsedFile) -> None`
    — streams and laps; no-op if already present. Fill a missing `distance`
    channel from positions and set `distance_calculated = 1`.
  - `write_source(conn, src: SourceActivity, activity_id: str, *, now: str) -> None`
    — upserts derived columns. It never changes identity columns of an
    existing row, except as described in Task 6.
  - `recompute_activity(conn, activity_id: str) -> None`

`recompute_activity` rules:

- **Which sources count:** the non-deleted source rows, ordered Strava then
  Garmin. If none remain, use all rows and set `visible = 0`.
- **Plain values:** each takes the first non-null across those sources. That
  covers `name`, `type`, `start_time`, `elapsed_time`, `moving_time`,
  `distance`, `utc_offset_s`, every `reported` key, and the zones.
  - A reported key maps to the column of the same name without `_m`
    (`elevation_gain_m` → `elevation_gain`).
- **Never calculated:** `calories`, `aerobic_te` and `anaerobic_te` stay NULL
  when no source reports them.
- **Streams:** `streams_sha256` is the first source whose file has a
  `streams` row with `sample_count > 0`.
- **Gap fill** (each name added to `calculated`):
  - `avg_hr` / `avg_cadence` / `avg_power`: time-weighted mean.
  - `max_*`: series max.
  - `elevation_gain` / `elevation_loss`: hysteresis.
  - `hr_zone_seconds`: only when an HR stream exists. It uses
    `hr_zone_limits` from the `activity_sources` row with zones whose
    `start_time` is closest to this activity's. If no source anywhere has
    zones, it stays NULL.
  - `utc_offset_s`: `local_offset_s` at the start fix.
  - `distance`: the last value of the distance stream.
- **Always computed:**
  - `polyline`, `start_lat` / `start_lng` and the bbox from lat/lon
  - the `has_*` flags from stream presence
  - `end_time = start_time + (elapsed or moving or 0)`
  - `start_local` (an ISO string without offset)
  - `meta_provider`
  - `activity_gear` rows
  - `visible = has a non-deleted source AND NOT activity_overrides.hidden`

- [ ] **Step 1: Write the failing tests**

```python
# test_calc.py
def _outdoor():
    with open(os.path.join(FIX, "outdoor.fit"), "rb") as f:
        return parse_fit(f)

def test_time_in_zones_matches_garmin_convention():
    p = _outdoor()
    got = calc.time_in_zones(p.streams["time"], p.streams["hr"], [97, 116, 136, 155, 175, 194])
    assert got == [1741.0, 1305.0, 652.0, 0.0, 0.0, 0.0, 0.0]      # Garmin reports 1741.278 / 1304.387 / 652.002

def test_elevation_hysteresis_matches_reported_within_2m():
    gain, loss = calc.elevation_gain_loss(_outdoor().streams["altitude"])
    assert gain == pytest.approx(130.2, abs=0.05) and loss == pytest.approx(124.0, abs=0.05)

def test_time_weighted_mean_ignores_missing():
    assert calc.time_weighted_mean([0, 10, 20, 30], [100, None, 200, 999]) == pytest.approx(150.0)

def test_local_offset_from_coordinates():
    assert calc.local_offset_s(46.05, 14.5, datetime(2026, 2, 18, 16, tzinfo=timezone.utc)) == 3600
    assert calc.local_offset_s(46.05, 14.5, datetime(2025, 7, 10, 5, tzinfo=timezone.utc)) == 7200

# test_merge.py — helper builds SourceActivity with sensible defaults
def _src(provider, pid, **kw) -> SourceActivity: ...
def _fresh(): conn = db.connect(":memory:"); db.init_schema(conn); return conn

def test_strava_wins_and_garmin_fills_gaps():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1", name="Strava name", reported={"elevation_gain_m": 120.0}), "a1", now=NOW)
    merge.write_source(conn, _src("garmin", "9", name="Garmin name", reported={"elevation_gain_m": 131.0, "calories": 330.0}), "a1", now=NOW)
    merge.recompute_activity(conn, "a1")
    r = conn.execute("SELECT * FROM activities WHERE id='a1'").fetchone()
    assert (r["name"], r["elevation_gain"], r["calories"]) == ("Strava name", 120.0, 330.0)
    assert json.loads(r["calculated"]) == []

def test_manual_strava_entry_takes_garmin_streams():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1", parsed=None, file_sha256=None), "a1", now=NOW)
    g = _src("garmin", "9", parsed=_outdoor(), file_sha256="f" * 64)
    merge.write_file_data(conn, g.file_sha256, g.parsed); merge.write_source(conn, g, "a1", now=NOW)
    merge.recompute_activity(conn, "a1")
    r = conn.execute("SELECT * FROM activities WHERE id='a1'").fetchone()
    assert r["streams_sha256"] == "f" * 64 and r["has_hr"] == 1 and r["has_gps"] == 1 and r["polyline"] != ""

def test_calculated_avg_hr_is_flagged():
    # one garmin source with outdoor streams, reported avg_hr None -> avg_hr ≈ 97.3, "avg_hr" in calculated
    ...

def test_deleted_strava_falls_back_to_garmin_and_all_deleted_hides():
    # set deleted_at on strava row -> name == "Garmin name", visible 1; delete garmin too -> visible 0, name kept
    ...

def test_zone_limits_come_from_closest_garmin_source():
    # garmin source A (zones limits [100,...], start 2025-01-01), B (limits [97,...], start 2026-02-01);
    # strava-only TCX activity at 2026-02-18 with HR stream -> hr_zone_limits == B's, "hr_zone_seconds" in calculated
    ...

def test_hidden_override_sets_visible_0(): ...

def test_source_urls():
    assert merge.source_url("strava", "123") == "https://www.strava.com/activities/123"
    assert merge.source_url("garmin", "123") == "https://connect.garmin.com/modern/activity/123"
```

Fill in the four `...` tests using the comments as their exact assertions.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `calc.py`, then `merge.py`. Add the pin to
  `requirements.txt` and install it.
- [ ] **Step 4: Run `pnpm run test:py`, expect PASS.**
- [ ] **Step 5: Commit** — `feat: recompute merged activities with provider-first values`

---

### Task 6: Matcher with random IDs and overlap matching

**Files:**
- Create: `ingest/matcher.py`
- Modify: `README.md` (replace the "±90 s start time, ±5% distance" sentence
  with the Task 6 rules)
- Test: `ingest/tests/test_matcher.py`

**Interfaces:**
- Consumes: `merge.write_file_data`, `merge.write_source`,
  `merge.recompute_activity`, `SourceActivity`.
- Produces:
  - `new_activity_id(conn) -> str` — matches `^[a-z0-9]{10}$` and is unused
    in `activities` / `activity_sources`.
  - `reconcile(conn, src: SourceActivity, *, now: str) -> str` — returns
    `"update" | "merge" | "insert"`.

Rules:

0. Write the file data first if `src.parsed` is present.
1. **Known record:** a row for (`provider`, `provider_activity_id`) exists.
   - Rewrite its derived columns and keep `activity_id` and `pinned`.
   - Clear `deleted_at` only when `src.fetched_at > deleted_at`. Older records
     replayed by a rebuild must not undelete.
   - If no `activities` row exists yet (a rebuild), create it with that ID.
   - Recompute, and return `"update"`.
2. **Candidates:** activities that have no **non-deleted** source from
   `src.provider`, and whose `[start_time − 180 s, end_time + 180 s]` window
   intersects `src`'s range.
3. **Score each candidate:**
   - When both ranges have positive length:
     `overlap = min(e, ce) − max(s, cs)`. Accept when
     `overlap ≥ 0.5 × min(e − s, ce − cs)`.
   - Otherwise, accept when `|s − cs| ≤ 180 s`.
   - **Distance guard:** when `src` has GPS and the candidate has
     `has_gps = 1`, and both distances are > 0, reject when
     `|d1 − d2| / max(d1, d2) > 0.20`.
   - **Pick:** the highest overlap ratio; ties go to the smallest start delta.
   - **Type differences:** `warnings.warn` on a type mismatch, but don't block.
4. **Match found:** write the source with that ID, recompute, return
   `"merge"`.
5. **No match:** create a new ID and activity, write the source, recompute,
   return `"insert"`.

- [ ] **Step 1: Write the failing tests** (each builds sources with `_src`
  and timestamps on 2026-08-01)

```python
ID_RE = re.compile(r"^[a-z0-9]{10}$")

def test_insert_assigns_random_neutral_id():
    conn = _fresh()
    assert matcher.reconcile(conn, _src("strava", "1", start="06:00", elapsed=3600), now=NOW) == "insert"
    assert ID_RE.match(conn.execute("SELECT id FROM activities").fetchone()[0])

def test_same_record_again_updates_in_place():
    # reconcile twice -> "update", one activity, id unchanged

def test_crop_on_one_provider_still_merges():
    # strava 06:00 +3600, garmin 06:10 +2700 -> "merge", one activity

def test_same_provider_records_never_merge():
    # two garmin records 06:00 +3600 and 06:05 +3600 -> two activities

def test_distance_guard_blocks_gps_mismatch():
    # both with GPS (parsed with lat), 10000 m vs 7000 m, same range -> "insert"

def test_zero_or_missing_elapsed_uses_start_window():
    # strava elapsed None at 06:30:00 + garmin 06:32:00 +600 -> "merge"; a garmin at 06:34:00 -> "insert"
    # strava elapsed 0 must not raise ZeroDivisionError

def test_deleted_slot_frees_for_reupload():
    # strava "1" + garmin "9" merged; set strava "1" deleted_at; strava "2" same range -> "merge" into same id

def test_old_record_does_not_undelete_but_newer_does():
    # deleted_at=2026-10-20; reconcile strava "1" fetched_at 2026-10-01 -> still deleted; fetched_at 2026-10-25 -> cleared

def test_type_mismatch_warns_but_merges():
    # strava Run vs garmin Walk, same range -> pytest.warns(UserWarning) and "merge"

def test_pinned_source_keeps_activity_on_update():
    # set pinned=1 and activity_id='keepme0001'; reconcile same record -> activity_id unchanged
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `matcher.py`. Update the README matcher paragraph.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat: match sources by time-range overlap with random activity ids`

---

### Task 7: Ingest engine and Strava importer

**Files:**
- Create: `ingest/engine.py`
- Modify: `ingest/strava_import.py`, `README.md` (import commands take the
  export zip; `ARCHIVE_URL`)
- Test: `ingest/tests/test_engine.py`, `ingest/tests/test_strava_import.py`
  (rewrite)

**Interfaces:**
- Consumes: `Archive`, `SourceRecord`, `latest`, `parse_bytes`,
  `matcher.reconcile`, `db.open_db`, `merge.recompute_activity`.
- Produces, in `ingest/engine.py`:
  - `register(kind: str, mapper: Callable[[SourceRecord, ParsedFile | None], SourceActivity]) -> None`
  - `to_source(rec: SourceRecord, archive: Archive) -> SourceActivity`
    - Parses the file blob through `parse_bytes(rec.file_name, blob)`.
    - On a parse error it warns `"unreadable activity file <name>: <err>"` and
      uses `parsed=None`.
    - It then dispatches on `rec.origin["kind"]`.
  - `apply_records(conn, archive, records: Iterable[SourceRecord], *, now: str) -> dict[str, int]`
    - Normalizes everything, sorts by `(start_time, provider, provider_activity_id)`
      and reconciles.
    - Returns counts for `insert` / `update` / `merge`.
    - Also writes `raw_files` rows for each record's file blob and origin refs.
  - `mark_missing_deleted(conn, provider: str, seen_ids: set[str], start: str, end: str, *, now: str) -> int`
    - Sets `deleted_at = now` on non-deleted rows of `provider` whose
      `start_time` is in `[start, end]` and whose ID is not in `seen_ids`.
    - Recomputes their activities and returns the count.
- Produces, in `ingest/strava_import.py`:
  - `StravaImporter(export_path: str, db_path: str, archive: Archive, *, now: str | None = None)`
  - `.run() -> dict[str, int]`
  - `record_to_source(rec, parsed) -> SourceActivity`, registered for
    `"strava_export"`.
  - CLI: `python -m ingest.strava_import <export.zip|dir> [--db PATH] [--archive URL]`.

`StravaImporter.run()`:

1. **Archive the export.**
   - A zip goes through `archive.put_export("strava", path, today=…)`.
   - A directory warns `"directory input: no export archive stored"`.
2. **Read `activities.csv`.** Locate it as the shortest member or path ending
   in `activities.csv`. Store it with `put_blob`, then read it with
   `csv.DictReader` (the last duplicate column wins).
3. **Check headers.** Warn once, listing every mapped header that is absent:

   ```python
   CSV_FIELDS = {"Activity ID": "id", "Activity Date": "start", "Activity Name": "name",
       "Activity Type": "type", "Elapsed Time": "elapsed_s", "Moving Time": "moving_s",
       "Distance": "distance_m", "Elevation Gain": "elevation_gain_m",
       "Elevation Loss": "elevation_loss_m", "Average Heart Rate": "avg_hr",
       "Max Heart Rate": "max_hr", "Average Cadence": "avg_cadence", "Max Cadence": "max_cadence",
       "Average Watts": "avg_power", "Max Watts": "max_power", "Calories": "calories",
       "Activity Gear": "gear", "Filename": "file"}
   ```

4. **Build a record per row.**
   - Find the `Filename` member by suffix, gunzip it if `.gz`, and `put_blob`
     the decompressed bytes.
   - Build a `SourceRecord`:
     - `summary` = the row
     - `file_name` without `.gz`
     - `origin = {"kind": "strava_export", "export_key": key_or_None, "csv_sha": sha}`
   - Then `put_record`.
5. **Apply.** `engine.apply_records` on `latest` of the archive's records for
   the IDs just read. Then `mark_missing_deleted("strava", seen, min_start, max_start)`.
6. **Commit.**

`record_to_source` for Strava:

- **Reported values:** CSV values first, then the file summary.
- **Type:** through `normalize.canonical_type`.
- **Start time:** "Activity Date" in UTC (the existing `_parse_date`).
- **UTC offset:** from the file (`parsed.utc_offset_s`), otherwise None;
  `recompute` fills it from coordinates.
- **Gear:** `[row["Activity Gear"]]` when non-empty.

- [ ] **Step 1: Write the failing tests** (build the export as a zip in
  `tmp_path`, using `sample.gpx` and `outdoor.fit` as members)

```python
def test_zip_import_archives_export_and_maps_csv(tmp_path, recwarn):
    # csv rows: 111 Run with "Average Heart Rate"=150, Filename activities/111.fit.gz (outdoor.fit gzipped);
    #           222 Weight Training, no file
    counts = StravaImporter(zip_path, db, arch).run()
    assert counts == {"insert": 2, "update": 0, "merge": 0}
    assert (tmp_path / "arch" / "exports" / "strava").iterdir()   # byte-identical copy (compare bytes)
    run = _activity_for(conn, "strava", "111")
    assert run["avg_hr"] == 150 and run["has_hr"] == 1 and run["polyline"] != ""   # CSV beats file's 97
    gym = _activity_for(conn, "strava", "222")
    assert gym["type"] == "WeightTraining" and gym["polyline"] == "" and gym["has_hr"] == 0

def test_missing_mapped_headers_warn_once(tmp_path):
    # minimal csv with only ID/Date/Name/Type/Filename -> one UserWarning naming "Average Heart Rate" and "Elevation Loss"

def test_corrupt_file_keeps_activity_without_streams(tmp_path):
    # Filename points to b"garbage" saved as activities/111.fit -> warning "unreadable activity file", activity stored, streams_sha256 is None

def test_reimport_is_idempotent(tmp_path):
    # run twice -> second counts {"insert": 0, "update": 2, "merge": 0}; record file count unchanged; ids unchanged

def test_newer_export_missing_activity_marks_it_deleted(tmp_path):
    # export 1: 111, 222 (Aug 1, Aug 2); export 2: 111 + 333 (Aug 3) -> 222 deleted_at set, its activity visible 0

def test_directory_input_warns_no_export_stored(tmp_path): ...
def test_parse_date_am_pm_is_utc(): ...        # keep the existing test
def test_duplicate_distance_columns_last_wins(tmp_path): ...   # keep, adapted to the new API
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `engine.py`, then rewrite `strava_import.py`.
  Update the npm script usage text and the README "Populating the database"
  section for zip input and `ARCHIVE_URL`.
- [ ] **Step 4: Run `pnpm run test:py`, expect PASS.**
- [ ] **Step 5: Commit** — `feat: archive Strava exports and import through the v2 engine`

---

### Task 8: Garmin importer on the engine

**Files:**
- Modify: `ingest/garmin_import.py`
- Test: `ingest/tests/test_garmin_import.py` (rewrite)

**Interfaces:**
- Consumes: the Task 7 engine API.
- Produces:
  - `GarminImporter(export_path: str, db_path: str, archive: Archive, *, match_window_s: int = 90, now: str | None = None)`
  - `.run() -> dict[str, int]`
  - `record_to_source`, registered for `"garmin_export"`.
  - The CLI mirrors Strava's.

`run()`:

1. Archive the export, as in Strava's step 1.
2. Store every `*summarizedActivities.json` member with `put_blob`.
3. Index the activity FITs from `UploadedFiles_*.zip` (the existing
   `_fit_index` logic), keeping each FIT's bytes.
4. For each summary, take the FIT within `match_window_s` of `startTimeGmt`,
   `put_blob` it, and build a record with
   `origin = {"kind": "garmin_export", "export_key": …, "summary_sha": …}`.
5. Apply, then `mark_missing_deleted("garmin", …)`.

`record_to_source` for the Garmin export (scaled units):

- Verified fields:
  - `activityId`, `name`, `activityType`
  - `startTimeGmt` (ms)
  - `distance` (cm)
  - `duration` (ms) → elapsed
  - `movingDuration` (ms)
  - `elevationGain` (cm)
- Also map `elevationLoss` (cm), `avgHr`, `maxHr` and `calories` **when
  present**. These names are unverified.
- The file summary fills every other reported key.
- `hr_zones` and `utc_offset_s` come from the FIT.

- [ ] **Step 1: Write the failing tests**

```python
def test_matches_fit_and_scales_units(tmp_path):
    # existing fixture layout, zipped; 900001 -> type Run, distance 10250.5, elevation_gain 120.0 (summary beats FIT's 130),
    #   moving_time 3600, avg_hr 97 (from FIT session), hr_zone_seconds[:3] == [1741.278, 1304.387, 652.002], utc_offset_s 3600
    # 900002 -> no FIT, polyline "", moving_time 2400, distance 0.0

def test_strava_then_garmin_merge_with_strava_name(tmp_path):
    # strava export with "Morning Walk" at outdoor.fit's start (Filename = outdoor.fit.gz) + garmin export 900001 -> one activity,
    #   name "Morning Walk", both sources present, streams_sha256 shared (same FIT bytes -> one streams row)

def test_iter_summaries_flattens_nested(): ...   # keep
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat: archive Garmin exports and import through the v2 engine`

---

### Task 9: Garmin fetch on the engine; remove v1 modules

**Files:**
- Modify: `ingest/garmin_fetch.py`, `ingest/tests/test_garmin_fetch.py`,
  `ingest/tests/test_base.py`
- Delete: `ingest/dedupe.py`, `ingest/store.py`, `ingest/base.py`,
  `ingest/tests/test_dedupe.py`, `ingest/tests/test_store.py`
- Delete: `RawActivity` / `Activity` from `ingest/model.py`, and
  `normalize.normalize()` with its tests (keep `canonical_type`, `simplify`,
  `encode`)
- Modify: `ingest/strava_fetch.py` (the stub subclasses nothing; it just raises
  `NotImplementedError` from `activities()` / `main()` as today)

**Interfaces:**
- Consumes: the engine, `Archive` and `GarminPersonalApi` (unchanged).
- Produces:
  - `GarminFetcher(db_path, archive, *, delay_s=1.0, client=None, key_file=None, page_size=100, now=None)`
  - `.run() -> dict[str, int]`
  - `record_to_source`, registered for `"garmin_api"`.
  - CLI flags: `--db` and `--archive`. Keep `--api-key-file`.
  - Exit codes 2 and 3 are unchanged.

Behaviour:

- **Unchanged:** high-water paging (now `MAX(start_time)` over `activities`),
  the 1 req/s delay, `has_gps_hint`, and the consecutive-failure stop.
- **New:**
  - Every list page's JSON bytes go to `put_blob` (`raw_files.kind = "api_response"`).
  - Every downloaded ZIP goes to `put_blob`.
  - The activity file is extracted from the ZIP (prefer `.fit`, then `.tcx`,
    then `.gpx`, as today) and stored decompressed with `put_blob`.
  - Record: `origin = {"kind": "garmin_api", "list_sha": …, "zip_sha": …}`,
    and `summary` = the DTO.
- **DTO mapping** (meters and seconds, no scaling):
  - `activityName`
  - `activityType.typeKey`
  - `startTimeGMT`
  - `utc_offset_s = startTimeLocal − startTimeGMT`
  - `distance`
  - `duration` → elapsed
  - `movingDuration`
  - `elevationGain`
  - Plus `elevationLoss`, `averageHR`, `maxHR` and `calories` when present
    (unverified).
- **Out of scope here:** the 30-day re-check, deletion detection and wellness
  are Plan 2.

- [ ] **Step 1: Update the tests.**
  - Keep the existing ZIP-extraction, paging, auth and failure tests, adapted
    to the new constructor.
  - Add:

```python
def test_fetch_archives_list_page_zip_and_file(tmp_path):
    # FakeClient with the fixture list + _zip("outdoor.fit") -> archive has 3 blobs per GPS item path (page, zip, fit),
    #   one record with origin kind "garmin_api"; activity utc_offset_s == 7200 (08:30 local vs 06:30 GMT in fixture)

def test_fetch_merges_with_existing_strava_activity(tmp_path):
    # strava import first with an activity at 2026-09-12T06:30:00Z +3300 -> fetch -> "merge" counts 1, one activity
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the fetcher, delete the v1 modules and their
  tests, and fix the imports.**
  - `grep -rn "store\.\|dedupe\.\|RawActivity\|from .base\|normalize\.normalize" ingest`
    must return nothing.
- [ ] **Step 4: Run `pnpm run test:py`, expect PASS.**
- [ ] **Step 5: Commit** — `feat: run the Garmin fetch through the v2 engine and drop v1 ingest`

---

### Task 10: Rebuild and schema-version handling

**Files:**
- Create: `ingest/rebuild.py`
- Modify: `ingest/engine.py` (add `open_for_write`), the three entry points
  (call it), `package.json` (add a `rebuild` script), `README.md` (a Rebuild
  section)
- Test: `ingest/tests/test_rebuild.py`

**Interfaces:**
- Produces, in `ingest/rebuild.py`: `rebuild(db_path: str, archive: Archive, *, now: str) -> dict[str, int]`
  1. Read the kept state from the current database if it exists:
     `activity_sources` (`provider`, `provider_activity_id`, `activity_id`,
     `pinned`, `deleted_at`) and `activity_overrides`.
  2. Build a fresh database at `<db_path>.rebuild`: init the schema, insert
     the kept rows, then `apply_records(latest(archive.list_records()))`.
  3. `os.replace` it over `db_path`.
  4. Return the apply counts.
- Produces, in `ingest/engine.py`: `open_for_write(db_path, archive, *, now) -> sqlite3.Connection`
  - On `NeedsRebuild` it runs `rebuild` and reopens.
  - On `SchemaMismatch` it prints
    `"v1 database at <path>: import fresh exports into a new database (see migration)"`
    and exits with code **4**.
- npm: `"rebuild": "${PYTHON_BIN:-python3} -m ingest.rebuild"`, with CLI
  options `--db` and `--archive`.

- [ ] **Step 1: Write the failing tests**

```python
def test_rebuild_is_deterministic_and_keeps_ids(tmp_path):
    # strava + garmin imports (merged pair + one each side) -> snapshot SELECT * FROM activities ORDER BY id
    # rebuild -> identical rows (all columns); rebuild again -> identical

def test_rebuild_keeps_pinned_split_deleted_and_hidden(tmp_path):
    # split via direct identity edit (pinned) + deleted_at on one source + hidden override -> rebuild -> all three preserved,
    #   split sources still on different activities

def test_writer_rebuilds_older_v2_and_refuses_v1(tmp_path):
    # set user_version=1 on a v2 db -> open_for_write rebuilds (user_version back to 2, ids kept)
    # v1 db -> SystemExit code 4
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat: rebuild the database from the archive with stable ids`

---

### Task 11: Manual fixes CLI

**Files:**
- Create: `ingest/activity_cli.py`
- Modify: `package.json` (add an `activity` script), `README.md` (a Manual
  fixes section)
- Test: `ingest/tests/test_activity_cli.py`

**Interfaces:**
- Produces: the functions below, and the CLI
  `python -m ingest.activity_cli {merge,split,hide,unhide} … [--db PATH]`.
  - **`merge(conn, keep_id: str, other_id: str) -> None`**
    - Moves every source of `other_id` to `keep_id`.
    - Sets `pinned = 1` on all of `keep_id`'s sources.
    - Deletes `other_id`'s `activities` and `activity_overrides` rows.
    - Recomputes `keep_id`.
  - **`split(conn, activity_id: str, provider: str, provider_activity_id: str) -> str`**
    - Gives that source a new ID and pins every source of both activities.
    - Recomputes both and returns the new ID.
    - Raises `ValueError` if that is the activity's only source.
  - **`set_hidden(conn, activity_id: str, hidden: bool) -> None`** — upserts
    `activity_overrides` and recomputes.
- Plan 3 wraps these in pull / conditional-upload.

- [ ] **Step 1: Write the failing tests**

```python
def test_merge_moves_sources_pins_and_survives_reimport(tmp_path):
    # two separate activities (no auto-match: 2 h apart) -> merge -> one activity with 2 sources, all pinned;
    #   re-running both imports keeps them merged

def test_split_creates_new_pinned_activity(tmp_path):
    # merged pair -> split garmin source -> 2 activities, new id matches ^[a-z0-9]{10}$; re-import keeps them split

def test_split_only_source_raises(): ...

def test_hide_and_unhide_toggle_visible(tmp_path): ...
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm run test:py` and `pnpm run test`, expect PASS.**
- [ ] **Step 5: Commit** — `feat: add manual merge, split and hide commands`

---

## Measurement hand-off (no code)

When the owner's fresh exports exist, run the importers into a scratch
database and archive, then report:

- **Sizes:**
  - database file
  - archive `raw/` and `exports/`
  - total of `streams` blob bytes
- **Coverage:** counts of `has_gps`, `has_hr`, `has_altitude`, `has_cadence`
  and `has_power`.
- **Header warnings:** any absent-header warnings from Strava and Garmin.
- **Unverified Garmin names:** which summary and DTO field names actually
  exist, for the fields mapped as unverified in Tasks 8 and 9.
- **Garmin gear:** where gear appears in the Garmin export and API. Plan 1
  imports gear from Strava's CSV only.
- **Pairs:** merged-pair count compared with v1's 352, with every difference
  explained.

These numbers feed Plans 2–4 and the matcher thresholds.
