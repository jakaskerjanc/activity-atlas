# Export/Fetch Ingestion → SQLite Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead Strava live-poll intake with a generic ingestion pipeline that consolidates bulk `.fit`/`.tcx`/`.gpx` exports (and, later, live fetch) into one committed SQLite store, feeding the existing build → `tracks.json` → Pages deploy.

**Architecture:** Four independently-runnable components (`strava_import`, `garmin_import`, `garmin_fetch`, `strava_fetch`). `StravaImporter`/`GarminImporter` extend `BaseImporter`; `GarminFetcher`/`StravaFetcher` extend `BaseFetcher`; both bases extend one `Ingestor` engine (`normalize → dedupe → store`). Each component reconciles against the store, so every run is idempotent and cross-source-aware. Python owns parse/normalize/dedupe/DB-writes; the TS build reads the DB via `better-sqlite3` and emits the wire format.

**Tech Stack:** Python 3.12 (`fitdecode`, `gpxpy`, `polyline`, stdlib `sqlite3`/`xml.etree`, `pytest`); TypeScript + tsx + `better-sqlite3` (build); React 19 + Mapbox GL (app, unchanged UI); `node:test` (pipeline), vitest (app).

**Spec:** `docs/2026-09-11-export-ingest-design.md`

## Global Constraints

- **Only 2 services exist** (`strava`, `garmin`); each of the 4 components maps to one. An activity row carries nullable `strava_id` + `garmin_id`; both set = present in both. No `source` column, no join table.
- **Canonical wire id** is `s:<stravaId>` / `g:<garminId>`; the prefix IS the canonical source. Assigned on first insert, **never changed on merge** (keeps links stable). Run `import:strava` **before** `import:garmin` so overlap activities get Strava-canonical ids.
- **Import-time geometry simplify: Douglas–Peucker ~0.5 m**, then precision-5 Google polyline. Idempotent — already-sparse sources pass through unchanged. `[]` track → `""` (no GPS).
- **Build-time simplify stays 5 m** (`scripts/simplify.ts`) for `tracks.json`. Wire **payload version 1 → 2**; bump in `scripts/build-tracks.ts` and `app/src/tracks.ts`.
- **Stats are source scalars**, never derived from geometry: distance (m), moving_time (s), elevation_gain (m). Garmin summary units are scaled — divide distance & elevation by 100, duration by 1000 (ms→s); Garmin `startTimeGmt` is epoch **ms**.
- **Strava `activities.csv` has duplicate `Distance` / `Elapsed Time` columns**; `csv.DictReader` keeps the **last** occurrence, which is the meters/seconds value we want. Lock this with a fixture test.
- **FIT positions are semicircles**: degrees = `value * 180 / 2**31`. Activity files are isolated by `file_id.type == 'activity'` (≈353 of 7,721 in the Garmin export; rest are monitoring).
- **Raw exports are never committed** (`.gitignore` covers `data/raw/` and `.venv/`); the importer reads an `--export-root` path. `data/activities.sqlite` **is** committed (source of truth, ≈1 MB).
- **Dedupe thresholds:** exact id-column match first; else cross-source start-time within **±90 s** AND moving_time within **±5 %**.
- **Merge policy (default):** name/stats → Strava wins; geometry → more points wins; both native ids always retained.
- **Python invoked via `${PYTHON_BIN:-python3}`** (same convention as existing scripts). Pin `requirements.txt` with `==`.
- Commit messages: extremely concise, sacrifice grammar for concision.

---

### Task 1: Python package scaffold, dependencies, and test fixtures

**Files:**
- Create: `requirements.txt`, `ingest/__init__.py`, `ingest/tests/__init__.py`
- Create fixtures: `ingest/tests/fixtures/sample.gpx`, `sample.tcx`, `strava_activities.csv`, `garmin_summaries.json`
- Create binary fixtures (copied + trimmed from the real export): `ingest/tests/fixtures/outdoor.fit`, `indoor.fit`, `monitoring.fit`, `garmin_uploaded.zip`
- Modify: `.gitignore`, `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: an importable `ingest` package, pinned deps, and fixtures every later test reads via `ingest/tests/fixtures/`.

- [ ] **Step 1: Create the venv and install libraries**

```bash
python3 -m venv .venv
.venv/bin/pip install --upgrade fitdecode gpxpy polyline pytest better-sqlite3 2>/dev/null || \
  .venv/bin/pip install --upgrade fitdecode gpxpy polyline pytest
```

- [ ] **Step 2: Pin `requirements.txt` from what resolved**

```bash
.venv/bin/pip freeze | grep -Ei '^(fitdecode|gpxpy|polyline|pytest)==' > requirements.txt
cat requirements.txt   # confirm 4 pinned lines
```

- [ ] **Step 3: Create the package markers**

`ingest/__init__.py` and `ingest/tests/__init__.py` — both empty files.

- [ ] **Step 4: Ignore the venv and raw data**

Append to `.gitignore` under `node_modules/`:

```
.venv/
data/raw/
```

- [ ] **Step 5: Write the text fixtures**

`ingest/tests/fixtures/sample.gpx`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>t</name><trkseg>
    <trkpt lat="46.05000" lon="14.50000"><time>2026-08-01T06:30:00Z</time></trkpt>
    <trkpt lat="46.05100" lon="14.50100"><time>2026-08-01T06:30:05Z</time></trkpt>
    <trkpt lat="46.05200" lon="14.50200"><time>2026-08-01T06:30:10Z</time></trkpt>
  </trkseg></trk>
</gpx>
```

`ingest/tests/fixtures/sample.tcx`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Running"><Lap><Track>
    <Trackpoint><Time>2026-08-01T06:30:00Z</Time>
      <Position><LatitudeDegrees>46.05000</LatitudeDegrees><LongitudeDegrees>14.50000</LongitudeDegrees></Position></Trackpoint>
    <Trackpoint><Time>2026-08-01T06:30:05Z</Time>
      <Position><LatitudeDegrees>46.05100</LatitudeDegrees><LongitudeDegrees>14.50100</LongitudeDegrees></Position></Trackpoint>
    <Trackpoint><Time>2026-08-01T06:30:10Z</Time></Trackpoint>
  </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>
```

`ingest/tests/fixtures/strava_activities.csv` — note the intentional duplicate `Distance` / `Elapsed Time` columns mirroring the real export (short id → GPS file, long id → no file):

```csv
Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time,Elevation Gain,Filename
111,"Aug 1, 2026, 6:30:00 AM",Morning Run,Run,3700,10.25,3600,120.0,activities/111.gpx
222,"Aug 2, 2026, 5:00:00 PM",Strength,Weight Training,2400,0,2400,0,
```

> The real export's second `Distance`/`Elapsed Time` columns hold meters/seconds. This trimmed fixture has one of each (already meters/seconds) plus the header order the parser targets; Task 10 adds a duplicate-column fixture variant.

`ingest/tests/fixtures/garmin_summaries.json` (array-of-arrays shape like the real file):

```json
[[{"activityId":900001,"name":"Ljubljana Run","activityType":"running","startTimeGmt":1785911400000,"distance":1025050,"duration":3700000,"movingDuration":3600000,"elevationGain":12000},
  {"activityId":900002,"name":"Gym","activityType":"strength_training","startTimeGmt":1785998400000,"distance":0,"duration":2400000,"movingDuration":null,"elevationGain":null}]]
```

- [ ] **Step 6: Create the binary FIT fixtures from the real export**

```bash
BASE="/mnt/c/Users/Administrator/Desktop/Exported data"
.venv/bin/python - "$BASE" <<'PY'
import sys, zipfile, io, glob, os, fitdecode
base=sys.argv[1]; out="ingest/tests/fixtures"; os.makedirs(out, exist_ok=True)
zf=zipfile.ZipFile(sorted(glob.glob(base+"/Garmin/DI_CONNECT/DI-Connect-Uploaded-Files/*.zip"))[0])
names=[n for n in zf.namelist() if n.lower().endswith('.fit')]
def ftype(b):
    with fitdecode.FitReader(io.BytesIO(b)) as fr:
        for f in fr:
            if isinstance(f,fitdecode.FitDataMessage) and f.name=='file_id':
                return f.get_value('type',fallback=None)
def gps_pts(b):
    n=0
    with fitdecode.FitReader(io.BytesIO(b)) as fr:
        for f in fr:
            if isinstance(f,fitdecode.FitDataMessage) and f.name=='record' and f.get_value('position_lat',fallback=None) is not None: n+=1
    return n
outdoor=indoor=monitoring=None
for n in names:
    b=zf.read(n); t=ftype(b)
    if t=='activity':
        if gps_pts(b)>0 and outdoor is None: outdoor=(n,b)
        elif gps_pts(b)==0 and indoor is None: indoor=(n,b)
    elif t!='activity' and monitoring is None: monitoring=(n,b)
    if outdoor and indoor and monitoring: break
open(out+"/outdoor.fit","wb").write(outdoor[1])
open(out+"/indoor.fit","wb").write(indoor[1])
open(out+"/monitoring.fit","wb").write(monitoring[1])
z=zipfile.ZipFile(out+"/garmin_uploaded.zip","w")
z.writestr("u_1.fit",outdoor[1]); z.writestr("u_2.fit",indoor[1]); z.writestr("u_3.fit",monitoring[1]); z.close()
print("outdoor",outdoor[0],"indoor",indoor[0],"monitoring",monitoring[0])
PY
```

> These are trimmed real activities used only as test fixtures (not the raw archive). If you prefer no personal coordinates in git, pick an activity away from home; the tests only assert point counts and shape, not specific coordinates.

- [ ] **Step 7: Add npm scripts and the build dependency**

In `package.json`, add to `"dependencies"`: `"better-sqlite3": "^11.0.0"`, and to `"scripts"`:

```json
    "import:strava": "${PYTHON_BIN:-python3} -m ingest.strava_import",
    "import:garmin": "${PYTHON_BIN:-python3} -m ingest.garmin_import",
    "test:py": "${PYTHON_BIN:-python3} -m pytest ingest -q"
```

Then `npm install` to fetch `better-sqlite3`.

- [ ] **Step 8: Verify the toolchain**

```bash
.venv/bin/python -c "import fitdecode, gpxpy, polyline, sqlite3, xml.etree.ElementTree; print('py ok')"
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(x)'); console.log('sqlite ok')"
ls ingest/tests/fixtures/
```
Expected: `py ok`, `sqlite ok`, and 8 fixture files listed.

- [ ] **Step 9: Commit**

```bash
git add requirements.txt ingest/ .gitignore package.json package-lock.json
git commit -m "chore: ingest scaffold, deps, test fixtures"
```

---

### Task 2: Data models

**Files:**
- Create: `ingest/model.py`
- Test: `ingest/tests/test_model.py`

**Interfaces:**
- Produces:
  - `RawActivity(source, source_id, name, type_raw, start_time: datetime, distance_m, moving_time_s, elevation_gain_m, track: list[tuple[float,float]], source_file=None)` — source-agnostic intermediate emitted by every component.
  - `Activity(id, strava_id, garmin_id, name, type, start_time: str, distance, moving_time, elevation_gain, polyline, start_lat, start_lng)` — the stored row shape.

- [ ] **Step 1: Write the failing test**

`ingest/tests/test_model.py`:

```python
from datetime import datetime, timezone
from ingest.model import RawActivity, Activity


def test_raw_activity_defaults():
    r = RawActivity(source="garmin", source_id="9", name="n", type_raw="running",
                    start_time=datetime(2026, 8, 1, tzinfo=timezone.utc),
                    distance_m=1.0, moving_time_s=2, elevation_gain_m=3.0)
    assert r.track == [] and r.source_file is None


def test_activity_fields():
    a = Activity(id="s:1", strava_id="1", garmin_id=None, name="n", type="Run",
                 start_time="2026-08-01T00:00:00+00:00", distance=1.0, moving_time=2,
                 elevation_gain=3.0, polyline="", start_lat=None, start_lng=None)
    assert a.id == "s:1" and a.garmin_id is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_model.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.model`.

- [ ] **Step 3: Implement**

`ingest/model.py`:

```python
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class RawActivity:
    """Source-agnostic intermediate emitted by every import/fetch component."""
    source: str                 # "strava" | "garmin"
    source_id: str
    name: str
    type_raw: str               # the source's own type key, pre-normalization
    start_time: datetime        # tz-aware UTC
    distance_m: float
    moving_time_s: int
    elevation_gain_m: float
    track: list[tuple[float, float]] = field(default_factory=list)  # (lat, lon) degrees
    source_file: str | None = None


@dataclass
class Activity:
    """The stored row. Canonical id prefix is the source; both native ids kept."""
    id: str
    strava_id: str | None
    garmin_id: str | None
    name: str
    type: str
    start_time: str             # ISO-8601 UTC
    distance: float             # meters
    moving_time: int            # seconds
    elevation_gain: float       # meters
    polyline: str               # precision-5; "" = no GPS
    start_lat: float | None
    start_lng: float | None
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_model.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ingest/model.py ingest/tests/test_model.py
git commit -m "feat: ingest data models"
```

---

### Task 3: Normalize (type map, units, time, simplify, encode)

**Files:**
- Create: `ingest/normalize.py`
- Test: `ingest/tests/test_normalize.py`

**Interfaces:**
- Consumes: `RawActivity`, `Activity` (Task 2).
- Produces:
  - `canonical_type(type_raw: str) -> str`
  - `simplify(track: list[tuple[float,float]], tol_m: float = 0.5) -> list[tuple[float,float]]`
  - `encode(track: list[tuple[float,float]]) -> str`
  - `normalize(raw: RawActivity, tol_m: float = 0.5) -> Activity`

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_normalize.py`:

```python
import warnings
from datetime import datetime, timezone
import polyline
from ingest.model import RawActivity
from ingest.normalize import canonical_type, simplify, encode, normalize


def test_canonical_type_strava_display_names():
    assert canonical_type("Run") == "Run"
    assert canonical_type("Weight Training") == "WeightTraining"
    assert canonical_type("Rock Climbing") == "RockClimbing"


def test_canonical_type_garmin_keys():
    assert canonical_type("running") == "Run"
    assert canonical_type("trail_running") == "Run"
    assert canonical_type("cycling") == "Ride"
    assert canonical_type("strength_training") == "WeightTraining"
    assert canonical_type("lap_swimming") == "Swim"
    assert canonical_type("tennis_v2") == "Tennis"


def test_canonical_type_unmapped_warns_and_titlecases():
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        assert canonical_type("underwater_hockey") == "UnderwaterHockey"
        assert any("Unmapped" in str(x.message) for x in w)


def test_simplify_thins_dense_but_keeps_ends():
    # a near-straight dense line collapses to its two endpoints at 0.5 m
    line = [(46.0 + i * 1e-6, 14.0) for i in range(50)]
    out = simplify(line, 0.5)
    assert out[0] == line[0] and out[-1] == line[-1]
    assert len(out) < len(line)


def test_simplify_idempotent_on_sparse():
    sparse = [(46.0, 14.0), (46.01, 14.01), (46.02, 14.0)]
    assert simplify(simplify(sparse, 0.5), 0.5) == simplify(sparse, 0.5)


def test_encode_roundtrips_within_precision5():
    pts = [(46.06, 14.5), (46.07, 14.51)]
    dec = polyline.decode(encode(pts), 5)
    assert len(dec) == 2
    assert abs(dec[0][0] - 46.06) < 1e-4


def test_encode_empty_for_degenerate():
    assert encode([]) == ""
    assert encode([(46.0, 14.0)]) == ""


def test_normalize_strava_run():
    a = normalize(RawActivity(source="strava", source_id="111", name="Morning Run",
                              type_raw="Run", start_time=datetime(2026, 8, 1, 6, 30, tzinfo=timezone.utc),
                              distance_m=10250.5, moving_time_s=3600, elevation_gain_m=120.0,
                              track=[(46.06, 14.5), (46.07, 14.51)]))
    assert a.id == "s:111" and a.strava_id == "111" and a.garmin_id is None
    assert a.type == "Run" and a.start_time == "2026-08-01T06:30:00+00:00"
    assert a.polyline and a.start_lat == 46.06


def test_normalize_garmin_no_gps():
    a = normalize(RawActivity(source="garmin", source_id="900002", name="Gym",
                              type_raw="strength_training", start_time=datetime(2026, 8, 2, tzinfo=timezone.utc),
                              distance_m=0, moving_time_s=2400, elevation_gain_m=0, track=[]))
    assert a.id == "g:900002" and a.garmin_id == "900002" and a.strava_id is None
    assert a.polyline == "" and a.start_lat is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_normalize.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.normalize`.

- [ ] **Step 3: Implement**

`ingest/normalize.py`:

```python
import math
import warnings
from datetime import datetime, timezone

import polyline

from .model import RawActivity, Activity

# Canonical vocabulary (Strava display names collapse into this set).
CANONICAL = {
    "Run", "Ride", "Hike", "Walk", "WeightTraining", "Workout", "Swim",
    "RockClimbing", "Rowing", "StairStepper", "Badminton", "Volleyball",
    "IceSkate", "Tennis",
}

# Garmin snake typeKeys -> canonical. Unmapped keys title-case + warn.
GARMIN_TYPE_MAP = {
    "running": "Run", "trail_running": "Run", "treadmill_running": "Run",
    "indoor_running": "Run", "track_running": "Run",
    "cycling": "Ride", "road_biking": "Ride", "mountain_biking": "Ride",
    "gravel_cycling": "Ride", "virtual_ride": "Ride", "indoor_cycling": "Ride",
    "hiking": "Hike", "mountaineering": "Hike",
    "walking": "Walk", "casual_walking": "Walk", "speed_walking": "Walk",
    "strength_training": "WeightTraining",
    "indoor_cardio": "Workout", "fitness_equipment": "Workout", "other": "Workout",
    "lap_swimming": "Swim", "open_water_swimming": "Swim",
    "indoor_climbing": "RockClimbing", "rock_climbing": "RockClimbing", "bouldering": "RockClimbing",
    "indoor_rowing": "Rowing", "rowing": "Rowing",
    "stair_climbing": "StairStepper",
    "badminton": "Badminton", "volleyball": "Volleyball",
    "ice_skating": "IceSkate", "skating_ws": "IceSkate",
    "tennis": "Tennis", "tennis_v2": "Tennis",
}


def canonical_type(type_raw: str) -> str:
    raw = type_raw.strip()
    pascal = "".join(w.capitalize() for w in raw.replace("-", " ").split())
    if pascal in CANONICAL:                       # Strava display names
        return pascal
    key = raw.lower().replace(" ", "_").replace("-", "_")
    if key in GARMIN_TYPE_MAP:                     # Garmin snake keys
        return GARMIN_TYPE_MAP[key]
    warnings.warn(f'Unmapped activity type "{type_raw}" -> "{pascal}". Add it to GARMIN_TYPE_MAP.')
    return pascal


def _perp_m(p, a, b) -> float:
    """Perpendicular distance (m) from p to segment a-b, equirectangular."""
    lat0 = math.radians(a[0]); mx = 111320 * math.cos(lat0); my = 110540
    ax, ay = a[1] * mx, a[0] * my
    bx, by = b[1] * mx, b[0] * my
    px, py = p[1] * mx, p[0] * my
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(track, tol_m: float = 0.5):
    """Iterative Douglas–Peucker in meters (no recursion-depth risk)."""
    n = len(track)
    if n < 3:
        return list(track)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        dmax, idx = 0.0, -1
        for k in range(i + 1, j):
            d = _perp_m(track[k], track[i], track[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > tol_m and idx != -1:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [track[i] for i in range(n) if keep[i]]


def encode(track) -> str:
    if len(track) < 2:
        return ""
    return polyline.encode([(lat, lon) for lat, lon in track], 5)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def normalize(raw: RawActivity, tol_m: float = 0.5) -> Activity:
    poly = encode(simplify(raw.track, tol_m)) if raw.track else ""
    if raw.source == "strava":
        aid, strava_id, garmin_id = f"s:{raw.source_id}", raw.source_id, None
    else:
        aid, strava_id, garmin_id = f"g:{raw.source_id}", None, raw.source_id
    return Activity(
        id=aid, strava_id=strava_id, garmin_id=garmin_id,
        name=raw.name, type=canonical_type(raw.type_raw),
        start_time=_iso(raw.start_time),
        distance=float(raw.distance_m), moving_time=int(raw.moving_time_s),
        elevation_gain=float(raw.elevation_gain_m), polyline=poly,
        start_lat=raw.track[0][0] if raw.track else None,
        start_lng=raw.track[0][1] if raw.track else None,
    )
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_normalize.py -q`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add ingest/normalize.py ingest/tests/test_normalize.py
git commit -m "feat: normalize types, units, geometry"
```

---

### Task 4: File parsers (GPX, TCX, FIT)

**Files:**
- Create: `ingest/parse/__init__.py`, `ingest/parse/gpx.py`, `ingest/parse/tcx.py`, `ingest/parse/fit.py`
- Test: `ingest/tests/test_parse.py`

**Interfaces:**
- Consumes: fixtures from Task 1.
- Produces:
  - `ParsedTrack(track: list[tuple[float,float]], start_time: datetime|None, sport: str|None, file_type: str|None)`
  - `parse_gpx(fileobj) -> ParsedTrack`
  - `parse_tcx(fileobj) -> ParsedTrack`
  - `parse_fit(fileobj, geometry: bool = True) -> ParsedTrack` (`geometry=False` reads only `file_id` → classify the haystack cheaply)

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_parse.py`:

```python
import os
from ingest.parse.gpx import parse_gpx
from ingest.parse.tcx import parse_tcx
from ingest.parse.fit import parse_fit

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def test_gpx():
    with open(os.path.join(FIX, "sample.gpx"), "rb") as f:
        p = parse_gpx(f)
    assert len(p.track) == 3
    assert p.track[0] == (46.05, 14.5)
    assert p.start_time is not None


def test_tcx_skips_points_without_position():
    with open(os.path.join(FIX, "sample.tcx"), "rb") as f:
        p = parse_tcx(f)
    assert len(p.track) == 2          # 3rd trackpoint has no Position
    assert p.track[1] == (46.051, 14.501)


def test_fit_outdoor_has_gps_and_type_activity():
    with open(os.path.join(FIX, "outdoor.fit"), "rb") as f:
        p = parse_fit(f)
    assert p.file_type == "activity"
    assert len(p.track) > 100
    assert p.start_time is not None
    lat, lon = p.track[0]
    assert -90 <= lat <= 90 and -180 <= lon <= 180   # semicircles converted


def test_fit_indoor_activity_has_no_gps():
    with open(os.path.join(FIX, "indoor.fit"), "rb") as f:
        p = parse_fit(f)
    assert p.file_type == "activity" and p.track == []


def test_fit_classify_only_is_cheap():
    with open(os.path.join(FIX, "monitoring.fit"), "rb") as f:
        p = parse_fit(f, geometry=False)
    assert p.file_type != "activity" and p.track == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_parse.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.parse.gpx`.

- [ ] **Step 3: Implement the shared dataclass**

`ingest/parse/__init__.py`:

```python
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ParsedTrack:
    track: list[tuple[float, float]] = field(default_factory=list)  # (lat, lon)
    start_time: datetime | None = None
    sport: str | None = None
    file_type: str | None = None   # FIT file_id.type; None for gpx/tcx
```

- [ ] **Step 4: Implement the GPX parser**

`ingest/parse/gpx.py`:

```python
import gpxpy
from . import ParsedTrack


def parse_gpx(fileobj) -> ParsedTrack:
    gpx = gpxpy.parse(fileobj)
    pts, start = [], None
    for trk in gpx.tracks:
        for seg in trk.segments:
            for p in seg.points:
                pts.append((p.latitude, p.longitude))
                if start is None and p.time is not None:
                    start = p.time
    return ParsedTrack(track=pts, start_time=start)
```

- [ ] **Step 5: Implement the TCX parser**

`ingest/parse/tcx.py`:

```python
import xml.etree.ElementTree as ET
from datetime import datetime
from . import ParsedTrack

_NS = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"}


def parse_tcx(fileobj) -> ParsedTrack:
    root = ET.parse(fileobj).getroot()
    pts, start = [], None
    for tp in root.iterfind(".//t:Trackpoint", _NS):
        pos = tp.find("t:Position", _NS)
        if pos is None:
            continue
        lat = pos.find("t:LatitudeDegrees", _NS)
        lon = pos.find("t:LongitudeDegrees", _NS)
        if lat is None or lon is None or not lat.text or not lon.text:
            continue
        pts.append((float(lat.text), float(lon.text)))
        if start is None:
            t = tp.find("t:Time", _NS)
            if t is not None and t.text:
                start = datetime.fromisoformat(t.text.replace("Z", "+00:00"))
    sport = root.find(".//t:Activity", _NS)
    return ParsedTrack(track=pts, start_time=start,
                       sport=sport.get("Sport") if sport is not None else None)
```

- [ ] **Step 6: Implement the FIT parser**

`ingest/parse/fit.py`:

```python
from datetime import timezone
import fitdecode
from . import ParsedTrack

_SEMI = 180 / 2 ** 31


def parse_fit(fileobj, geometry: bool = True) -> ParsedTrack:
    """Parse a FIT stream. geometry=False reads only file_id (cheap classify)."""
    pts, start, created, sport, ftype = [], None, None, None, None
    with fitdecode.FitReader(fileobj) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name == "file_id":
                ftype = frame.get_value("type", fallback=None)
                created = frame.get_value("time_created", fallback=None)
                if not geometry:
                    break
            elif frame.name == "session":
                start = start or frame.get_value("start_time", fallback=None)
                sport = sport or frame.get_value("sport", fallback=None)
            elif frame.name == "record":
                la = frame.get_value("position_lat", fallback=None)
                lo = frame.get_value("position_long", fallback=None)
                if la is not None and lo is not None:
                    pts.append((la * _SEMI, lo * _SEMI))
    start = start or created
    if start is not None and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return ParsedTrack(track=pts, start_time=start, sport=sport, file_type=ftype)
```

- [ ] **Step 7: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_parse.py -q`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add ingest/parse/ ingest/tests/test_parse.py
git commit -m "feat: fit/tcx/gpx parsers"
```

---

### Task 5: SQLite store

**Files:**
- Create: `ingest/store.py`
- Test: `ingest/tests/test_store.py`

**Interfaces:**
- Consumes: `Activity` (Task 2).
- Produces:
  - `connect(path) -> sqlite3.Connection`
  - `init_schema(conn) -> None`
  - `find_by_service_id(conn, service: str, sid: str) -> Activity | None`
  - `find_near(conn, start_iso: str, window_s: int) -> list[Activity]`
  - `upsert(conn, a: Activity) -> None`
  - `all_activities(conn) -> list[Activity]`

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_store.py`:

```python
from ingest import store
from ingest.model import Activity


def _act(**kw):
    base = dict(id="s:1", strava_id="1", garmin_id=None, name="n", type="Run",
                start_time="2026-08-01T06:30:00+00:00", distance=1.0, moving_time=100,
                elevation_gain=0.0, polyline="abc", start_lat=46.0, start_lng=14.0)
    base.update(kw)
    return Activity(**base)


def test_upsert_and_find_by_id():
    conn = store.connect(":memory:"); store.init_schema(conn)
    store.upsert(conn, _act())
    got = store.find_by_service_id(conn, "strava", "1")
    assert got is not None and got.id == "s:1" and got.polyline == "abc"
    assert store.find_by_service_id(conn, "garmin", "1") is None


def test_upsert_updates_in_place():
    conn = store.connect(":memory:"); store.init_schema(conn)
    store.upsert(conn, _act(name="old"))
    store.upsert(conn, _act(name="new", garmin_id="9"))
    got = store.find_by_service_id(conn, "strava", "1")
    assert got.name == "new" and got.garmin_id == "9"
    assert len(store.all_activities(conn)) == 1


def test_find_near_respects_window():
    conn = store.connect(":memory:"); store.init_schema(conn)
    store.upsert(conn, _act(id="s:1", strava_id="1", start_time="2026-08-01T06:30:00+00:00"))
    near = store.find_near(conn, "2026-08-01T06:31:00+00:00", 90)   # 60s away
    far = store.find_near(conn, "2026-08-01T06:40:00+00:00", 90)    # 600s away
    assert len(near) == 1 and far == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_store.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.store`.

- [ ] **Step 3: Implement**

`ingest/store.py`:

```python
import sqlite3
from datetime import datetime, timedelta
from .model import Activity

SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  strava_id TEXT,
  garmin_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  start_time TEXT NOT NULL,
  distance REAL NOT NULL,
  moving_time INTEGER NOT NULL,
  elevation_gain REAL NOT NULL,
  polyline TEXT NOT NULL,
  start_lat REAL,
  start_lng REAL
);
CREATE INDEX IF NOT EXISTS idx_strava ON activities(strava_id);
CREATE INDEX IF NOT EXISTS idx_garmin ON activities(garmin_id);
CREATE INDEX IF NOT EXISTS idx_start  ON activities(start_time);
"""

_COLS = ("id", "strava_id", "garmin_id", "name", "type", "start_time", "distance",
         "moving_time", "elevation_gain", "polyline", "start_lat", "start_lng")


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn):
    conn.executescript(SCHEMA)


def _row(r):
    return Activity(**{c: r[c] for c in _COLS})


def find_by_service_id(conn, service, sid):
    col = "strava_id" if service == "strava" else "garmin_id"
    r = conn.execute(f"SELECT * FROM activities WHERE {col}=?", (sid,)).fetchone()
    return _row(r) if r else None


def find_near(conn, start_iso, window_s):
    t = datetime.fromisoformat(start_iso)
    lo = (t - timedelta(seconds=window_s)).isoformat()
    hi = (t + timedelta(seconds=window_s)).isoformat()
    rows = conn.execute(
        "SELECT * FROM activities WHERE start_time BETWEEN ? AND ?", (lo, hi)
    ).fetchall()
    return [_row(r) for r in rows]


def upsert(conn, a: Activity):
    conn.execute(
        f"INSERT INTO activities ({','.join(_COLS)}) VALUES ({','.join('?' * len(_COLS))}) "
        "ON CONFLICT(id) DO UPDATE SET " +
        ", ".join(f"{c}=excluded.{c}" for c in _COLS if c != "id"),
        tuple(getattr(a, c) for c in _COLS),
    )


def all_activities(conn):
    return [_row(r) for r in conn.execute("SELECT * FROM activities").fetchall()]
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_store.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ingest/store.py ingest/tests/test_store.py
git commit -m "feat: sqlite store"
```

---

### Task 6: Dedupe & merge

**Files:**
- Create: `ingest/dedupe.py`
- Test: `ingest/tests/test_dedupe.py`

**Interfaces:**
- Consumes: `store` (Task 5), `Activity` (Task 2).
- Produces: `reconcile(conn, incoming: Activity, *, window_s=90, moving_pct=0.05, name_stats_winner="strava") -> str` returning `"insert" | "update" | "merge"`, mutating the store.

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_dedupe.py`:

```python
from ingest import store, dedupe
from ingest.model import Activity


def _a(**kw):
    base = dict(id="s:1", strava_id="1", garmin_id=None, name="Strava Name", type="Ride",
                start_time="2026-08-01T06:30:00+00:00", distance=100.0, moving_time=1000,
                elevation_gain=5.0, polyline="aaaa", start_lat=46.0, start_lng=14.0)
    base.update(kw)
    return Activity(**base)


def _fresh():
    conn = store.connect(":memory:"); store.init_schema(conn)
    return conn


def test_new_insert():
    conn = _fresh()
    assert dedupe.reconcile(conn, _a()) == "insert"
    assert len(store.all_activities(conn)) == 1


def test_exact_id_updates():
    conn = _fresh()
    dedupe.reconcile(conn, _a(name="old"))
    assert dedupe.reconcile(conn, _a(name="new")) == "update"
    assert store.find_by_service_id(conn, "strava", "1").name == "new"


def test_cross_source_merge_fills_other_id_keeps_canonical():
    conn = _fresh()
    dedupe.reconcile(conn, _a())                                  # strava first
    garmin = Activity(id="g:900", strava_id=None, garmin_id="900", name="Garmin Name",
                      type="Ride", start_time="2026-08-01T06:30:30+00:00",  # 30s off
                      distance=101.0, moving_time=1010, elevation_gain=5.0,
                      polyline="bbbbbbbb", start_lat=46.0, start_lng=14.0)   # denser geometry
    assert dedupe.reconcile(conn, garmin) == "merge"
    rows = store.all_activities(conn)
    assert len(rows) == 1
    m = rows[0]
    assert m.id == "s:1"                       # canonical id unchanged
    assert m.strava_id == "1" and m.garmin_id == "900"
    assert m.name == "Strava Name"             # name/stats: strava wins
    assert m.polyline == "bbbbbbbb"            # geometry: more points wins


def test_cross_source_no_match_when_time_far():
    conn = _fresh()
    dedupe.reconcile(conn, _a())
    other = _a(id="g:900", strava_id=None, garmin_id="900",
               start_time="2026-08-01T09:00:00+00:00")
    assert dedupe.reconcile(conn, other) == "insert"
    assert len(store.all_activities(conn)) == 2


def test_idempotent_reruns():
    conn = _fresh()
    dedupe.reconcile(conn, _a())
    dedupe.reconcile(conn, _a())
    dedupe.reconcile(conn, _a())
    assert len(store.all_activities(conn)) == 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_dedupe.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.dedupe`.

- [ ] **Step 3: Implement**

`ingest/dedupe.py`:

```python
from . import store
from .model import Activity


def _merge(base: Activity, incoming: Activity, winner: str) -> Activity:
    """Keep base.id (canonical, stable). Fill both native ids. Apply policy."""
    strava_id = base.strava_id or incoming.strava_id
    garmin_id = base.garmin_id or incoming.garmin_id
    inc_is_winner = (winner == "strava" and incoming.strava_id) or \
                    (winner == "garmin" and incoming.garmin_id)
    meta = incoming if inc_is_winner else base
    geo = incoming if len(incoming.polyline) > len(base.polyline) else base
    return Activity(
        id=base.id, strava_id=strava_id, garmin_id=garmin_id,
        name=meta.name, type=meta.type, start_time=meta.start_time,
        distance=meta.distance, moving_time=meta.moving_time,
        elevation_gain=meta.elevation_gain,
        polyline=geo.polyline, start_lat=geo.start_lat, start_lng=geo.start_lng,
    )


def reconcile(conn, incoming: Activity, *, window_s=90, moving_pct=0.05,
              name_stats_winner="strava") -> str:
    service = "strava" if incoming.strava_id else "garmin"
    sid = incoming.strava_id or incoming.garmin_id

    # 1. exact id-column match -> update in place
    existing = store.find_by_service_id(conn, service, sid)
    if existing:
        store.upsert(conn, _merge(existing, incoming, name_stats_winner))
        return "update"

    # 2. cross-source time + moving_time match
    for cand in store.find_near(conn, incoming.start_time, window_s):
        a, b = cand.moving_time, incoming.moving_time
        close = (a and b and abs(a - b) <= moving_pct * max(a, b)) or (not a and not b)
        if close:
            store.upsert(conn, _merge(cand, incoming, name_stats_winner))
            return "merge"

    # 3. new
    store.upsert(conn, incoming)
    return "insert"
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_dedupe.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ingest/dedupe.py ingest/tests/test_dedupe.py
git commit -m "feat: dedupe and merge policy"
```

---

### Task 7: Ingestor engine, base classes, and fetcher stubs

**Files:**
- Create: `ingest/base.py`, `ingest/garmin_fetch.py`, `ingest/strava_fetch.py`
- Test: `ingest/tests/test_base.py`

**Interfaces:**
- Consumes: `store`, `normalize`, `dedupe` (Tasks 3/5/6), `RawActivity` (Task 2).
- Produces:
  - `Ingestor(db_path, simplify_tol_m=0.5)` with abstract `activities() -> Iterable[RawActivity]` and `run() -> dict` (counts of insert/update/merge).
  - `BaseImporter(Ingestor)` with `open_activity_file(path) -> (name, fileobj)` and `parse_file(name, fileobj) -> ParsedTrack`.
  - `BaseFetcher(Ingestor)` with `high_water(conn) -> str | None`.
  - `GarminFetcher`, `StravaFetcher` stubs (raise `NotImplementedError` in `activities()`).

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_base.py`:

```python
import gzip
import io
from datetime import datetime, timezone

import pytest

from ingest.base import BaseImporter
from ingest.model import RawActivity
from ingest import store


class _Imp(BaseImporter):
    source = "strava"

    def __init__(self, db_path, items):
        super().__init__(db_path)
        self._items = items

    def activities(self):
        yield from self._items


def _raw(sid, t):
    return RawActivity(source="strava", source_id=sid, name="n", type_raw="Run",
                       start_time=t, distance_m=100.0, moving_time_s=1000,
                       elevation_gain_m=0.0, track=[(46.0, 14.0), (46.01, 14.01)])


def test_run_inserts_then_idempotent_update(tmp_path):
    db = str(tmp_path / "a.sqlite")
    t = datetime(2026, 8, 1, 6, 30, tzinfo=timezone.utc)
    c1 = _Imp(db, [_raw("1", t), _raw("2", t.replace(hour=9))]).run()
    assert c1["insert"] == 2
    c2 = _Imp(db, [_raw("1", t)]).run()
    assert c2["update"] == 1
    conn = store.connect(db)
    assert len(store.all_activities(conn)) == 2


def test_open_activity_file_gunzips(tmp_path):
    p = tmp_path / "x.gpx.gz"
    p.write_bytes(gzip.compress(b"<gpx/>"))
    name, fo = _Imp(str(tmp_path / "d.sqlite"), []).open_activity_file(str(p))
    try:
        assert name.endswith(".gpx") and not name.endswith(".gz")
        assert fo.read() == b"<gpx/>"
    finally:
        fo.close()


def test_parse_file_rejects_unknown_extension(tmp_path):
    with pytest.raises(ValueError):
        _Imp(str(tmp_path / "d.sqlite"), []).parse_file("x.csv", io.BytesIO(b""))


def test_fetcher_stub_raises(tmp_path):
    from ingest.garmin_fetch import GarminFetcher
    with pytest.raises(NotImplementedError):
        list(GarminFetcher(str(tmp_path / "d.sqlite")).activities())
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_base.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.base`.

- [ ] **Step 3: Implement the engine and bases**

`ingest/base.py`:

```python
import gzip
from abc import ABC, abstractmethod

from . import store, normalize, dedupe


class Ingestor(ABC):
    """Shared engine: pull RawActivity items, normalize, reconcile into the store.
    Every import/fetch component runs through this, so all are idempotent."""
    source: str = ""

    def __init__(self, db_path, simplify_tol_m: float = 0.5):
        self.db_path = db_path
        self.tol = simplify_tol_m

    @abstractmethod
    def activities(self):
        """Yield RawActivity items."""

    def run(self) -> dict:
        conn = store.connect(self.db_path)
        store.init_schema(conn)
        counts = {"insert": 0, "update": 0, "merge": 0}
        for raw in self.activities():
            counts[dedupe.reconcile(conn, normalize.normalize(raw, self.tol))] += 1
        conn.commit()
        conn.close()
        return counts


class BaseImporter(Ingestor):
    """Bulk import from local export files."""

    def open_activity_file(self, path):
        """Return (name_without_gz, binary_fileobj), transparently gunzipping."""
        if path.endswith(".gz"):
            return path[:-3], gzip.open(path, "rb")
        return path, open(path, "rb")

    def parse_file(self, name: str, fileobj):
        from .parse.fit import parse_fit
        from .parse.tcx import parse_tcx
        from .parse.gpx import parse_gpx
        low = name.lower()
        if low.endswith(".fit"):
            return parse_fit(fileobj)
        if low.endswith(".tcx"):
            return parse_tcx(fileobj)
        if low.endswith(".gpx"):
            return parse_gpx(fileobj)
        raise ValueError(f"unsupported activity file: {name}")


class BaseFetcher(Ingestor):
    """Live API fetch. Deferred phase — subclasses implement activities();
    high_water() supports incremental windowing off the store."""

    def high_water(self, conn):
        row = conn.execute("SELECT MAX(start_time) AS m FROM activities").fetchone()
        return row["m"] if row and row["m"] else None
```

- [ ] **Step 4: Implement the fetcher stubs**

`ingest/garmin_fetch.py`:

```python
"""Live Garmin Connect fetch — deferred phase (see design spec). This is the
architecture slot: a Source that feeds the same normalize/dedupe/store core."""
from .base import BaseFetcher


class GarminFetcher(BaseFetcher):
    source = "garmin"

    def activities(self):
        raise NotImplementedError("garmin_fetch is a later phase; see design spec")


def main():
    raise SystemExit("garmin_fetch not yet implemented")


if __name__ == "__main__":
    main()
```

`ingest/strava_fetch.py`:

```python
"""Live Strava fetch — deferred stub (Strava polling is dead today). Kept so the
fetcher base has a second implementation slot for when/if it returns."""
from .base import BaseFetcher


class StravaFetcher(BaseFetcher):
    source = "strava"

    def activities(self):
        raise NotImplementedError("strava_fetch is a later phase; see design spec")


def main():
    raise SystemExit("strava_fetch not yet implemented")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_base.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add ingest/base.py ingest/garmin_fetch.py ingest/strava_fetch.py ingest/tests/test_base.py
git commit -m "feat: ingestor engine, importer/fetcher bases, fetch stubs"
```

---

### Task 8: Strava importer

**Files:**
- Create: `ingest/strava_import.py`
- Test: `ingest/tests/test_strava_import.py`

**Interfaces:**
- Consumes: `BaseImporter` (Task 7), `RawActivity` (Task 2), fixtures (Task 1).
- Produces: `StravaImporter(export_root, db_path, **kw)` (stats from `activities.csv`, geometry from the referenced per-activity file) and a `main()` entry (`python -m ingest.strava_import <root> [--db]`).

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_strava_import.py`:

```python
import os
import shutil
from datetime import timezone

from ingest.strava_import import StravaImporter, _parse_date
from ingest import store

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _make_root(tmp_path, csv_text):
    root = tmp_path / "strava"
    (root / "activities").mkdir(parents=True)
    shutil.copy(os.path.join(FIX, "sample.gpx"), root / "activities" / "111.gpx")
    (root / "activities.csv").write_text(csv_text, encoding="utf-8")
    return str(root)


def test_parse_date_am_pm_is_utc():
    assert _parse_date("Aug 1, 2026, 6:30:00 AM").tzinfo == timezone.utc


def test_stats_from_csv_geometry_from_file(tmp_path):
    csv_text = (
        "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time,Elevation Gain,Filename\n"
        '111,"Aug 1, 2026, 6:30:00 AM",Morning Run,Run,3700,10250.5,3600,120.0,activities/111.gpx\n'
        '222,"Aug 2, 2026, 5:00:00 PM",Strength,Weight Training,2400,0,2400,0,\n'
    )
    db = str(tmp_path / "db.sqlite")
    assert StravaImporter(_make_root(tmp_path, csv_text), db).run()["insert"] == 2
    conn = store.connect(db)
    run = store.find_by_service_id(conn, "strava", "111")
    assert run.type == "Run" and run.distance == 10250.5 and run.moving_time == 3600
    assert run.polyline != ""
    gym = store.find_by_service_id(conn, "strava", "222")
    assert gym.type == "WeightTraining" and gym.polyline == ""


def test_duplicate_distance_columns_last_wins(tmp_path):
    # Real Strava exports repeat Distance; DictReader keeps the last = meters.
    csv_text = (
        "Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time,Elevation Gain,Distance,Filename\n"
        '111,"Aug 1, 2026, 6:30:00 AM",Run,Run,10.25,3600,120.0,10250.5,\n'
    )
    db = str(tmp_path / "db.sqlite")
    StravaImporter(_make_root(tmp_path, csv_text), db).run()
    conn = store.connect(db)
    assert store.find_by_service_id(conn, "strava", "111").distance == 10250.5
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_strava_import.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.strava_import`.

- [ ] **Step 3: Implement**

`ingest/strava_import.py`:

```python
import argparse
import csv
import os
from datetime import datetime, timezone

from .base import BaseImporter
from .model import RawActivity

_DATE_FMTS = ("%b %d, %Y, %I:%M:%S %p", "%b %d, %Y, %H:%M:%S")


def _parse_date(s: str) -> datetime:
    for fmt in _DATE_FMTS:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"unrecognized Strava date: {s!r}")


def _num(s, default=0.0) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


class StravaImporter(BaseImporter):
    source = "strava"

    def __init__(self, export_root, db_path, **kw):
        super().__init__(db_path, **kw)
        self.root = export_root

    def activities(self):
        with open(os.path.join(self.root, "activities.csv"), newline="", encoding="utf-8") as f:
            # DictReader keeps the LAST of any duplicate column -> meters/seconds.
            for row in csv.DictReader(f):
                yield self._to_raw(row)

    def _to_raw(self, row) -> RawActivity:
        track = []
        fname = (row.get("Filename") or "").strip()
        if fname:
            path = os.path.join(self.root, fname)
            if os.path.exists(path):
                name, fo = self.open_activity_file(path)
                try:
                    track = self.parse_file(name, fo).track
                finally:
                    fo.close()
        return RawActivity(
            source="strava",
            source_id=row["Activity ID"].strip(),
            name=(row.get("Activity Name") or "Untitled").strip(),
            type_raw=(row.get("Activity Type") or "Workout").strip(),
            start_time=_parse_date(row["Activity Date"].strip()),
            distance_m=_num(row.get("Distance")),
            moving_time_s=int(_num(row.get("Moving Time"))),
            elevation_gain_m=_num(row.get("Elevation Gain")),
            track=track,
            source_file=fname or None,
        )


def main():
    ap = argparse.ArgumentParser(description="Import a Strava bulk export into the SQLite store.")
    ap.add_argument("export_root", help="unzipped Strava export dir (contains activities.csv)")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--simplify-m", type=float, default=0.5)
    args = ap.parse_args()
    print(f"strava_import: {StravaImporter(args.export_root, args.db, simplify_tol_m=args.simplify_m).run()}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_strava_import.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ingest/strava_import.py ingest/tests/test_strava_import.py
git commit -m "feat: strava export importer"
```

---

### Task 9: Garmin importer

**Files:**
- Create: `ingest/garmin_import.py`
- Test: `ingest/tests/test_garmin_import.py`

**Interfaces:**
- Consumes: `BaseImporter` (Task 7), `parse_fit` (Task 4), fixtures (Task 1).
- Produces: `GarminImporter(export_root, db_path, match_window_s=90, **kw)` (stats from `*summarizedActivities.json`, geometry from time-matched activity FITs in `UploadedFiles_*.zip`), helper `_iter_summaries(obj)`, and a `main()` entry.

- [ ] **Step 1: Write the failing tests**

`ingest/tests/test_garmin_import.py`:

```python
import json
import os
import shutil

from ingest.garmin_import import GarminImporter, _iter_summaries
from ingest.parse.fit import parse_fit
from ingest import store

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _outdoor_start_ms():
    with open(os.path.join(FIX, "outdoor.fit"), "rb") as f:
        return int(parse_fit(f).start_time.timestamp() * 1000)


def _make_root(tmp_path):
    root = tmp_path / "garmin"
    fitdir = root / "DI_CONNECT" / "DI-Connect-Fitness"
    updir = root / "DI_CONNECT" / "DI-Connect-Uploaded-Files"
    fitdir.mkdir(parents=True)
    updir.mkdir(parents=True)
    shutil.copy(os.path.join(FIX, "garmin_uploaded.zip"), updir / "UploadedFiles_0-_Part1.zip")
    summaries = [[
        {"activityId": 900001, "name": "Match Run", "activityType": "running",
         "startTimeGmt": _outdoor_start_ms(), "distance": 1025050, "duration": 3700000,
         "movingDuration": 3600000, "elevationGain": 12000},
        {"activityId": 900002, "name": "Gym", "activityType": "strength_training",
         "startTimeGmt": 1785998400000, "distance": 0, "duration": 2400000,
         "movingDuration": None, "elevationGain": None},
    ]]
    (fitdir / "u_1_summarizedActivities.json").write_text(json.dumps(summaries))
    return str(root)


def test_iter_summaries_flattens_nested():
    got = [s["activityId"] for s in _iter_summaries([[{"activityId": 1}], {"activityId": 2}])]
    assert got == [1, 2]


def test_matches_fit_geometry_and_scales_units(tmp_path):
    db = str(tmp_path / "db.sqlite")
    assert GarminImporter(_make_root(tmp_path), db).run()["insert"] == 2
    conn = store.connect(db)
    run = store.find_by_service_id(conn, "garmin", "900001")
    assert run.type == "Run"
    assert run.distance == 10250.5 and run.elevation_gain == 120.0 and run.moving_time == 3600
    assert run.polyline != ""            # matched outdoor.fit
    gym = store.find_by_service_id(conn, "garmin", "900002")
    assert gym.polyline == ""            # no time-matched FIT
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_import.py -q`
Expected: FAIL — `ModuleNotFoundError: ingest.garmin_import`.

- [ ] **Step 3: Implement**

`ingest/garmin_import.py`:

```python
import argparse
import glob
import io
import json
import os
import zipfile
from datetime import datetime, timezone

from .base import BaseImporter
from .model import RawActivity
from .parse.fit import parse_fit


def _iter_summaries(obj):
    """Yield every dict with an activityId, however the JSON is nested."""
    if isinstance(obj, list):
        for x in obj:
            yield from _iter_summaries(x)
    elif isinstance(obj, dict):
        if "activityId" in obj:
            yield obj
        else:
            for v in obj.values():
                yield from _iter_summaries(v)


class GarminImporter(BaseImporter):
    source = "garmin"

    def __init__(self, export_root, db_path, match_window_s=90, **kw):
        super().__init__(db_path, **kw)
        self.root = export_root
        self.window = match_window_s

    def _summaries(self):
        out = []
        for path in glob.glob(os.path.join(self.root, "**", "*summarizedActivities.json"), recursive=True):
            with open(path, encoding="utf-8") as f:
                out.extend(_iter_summaries(json.load(f)))
        return out

    def _fit_index(self):
        """[(epoch_start, track)] for every activity-type FIT in UploadedFiles."""
        index = []
        for zpath in glob.glob(os.path.join(self.root, "**", "UploadedFiles_*.zip"), recursive=True):
            with zipfile.ZipFile(zpath) as zf:
                for name in zf.namelist():
                    if not name.lower().endswith(".fit"):
                        continue
                    raw = zf.read(name)
                    if parse_fit(io.BytesIO(raw), geometry=False).file_type != "activity":
                        continue
                    p = parse_fit(io.BytesIO(raw))
                    if p.start_time is not None:
                        index.append((p.start_time.timestamp(), p.track))
        return index

    def _track_for(self, start_epoch, index):
        for epoch, track in index:
            if abs(epoch - start_epoch) <= self.window:
                return track
        return []

    def activities(self):
        index = self._fit_index()
        for s in self._summaries():
            start = datetime.fromtimestamp(int(s["startTimeGmt"]) / 1000, tz=timezone.utc)
            yield RawActivity(
                source="garmin",
                source_id=str(s["activityId"]),
                name=s.get("name") or "Untitled",
                type_raw=s.get("activityType") or "other",
                start_time=start,
                distance_m=(s.get("distance") or 0) / 100.0,
                moving_time_s=int((s.get("movingDuration") or s.get("duration") or 0) / 1000),
                elevation_gain_m=(s.get("elevationGain") or 0) / 100.0,
                track=self._track_for(start.timestamp(), index),
            )


def main():
    ap = argparse.ArgumentParser(description="Import a Garmin bulk export into the SQLite store.")
    ap.add_argument("export_root", help="unzipped Garmin export dir (contains DI_CONNECT/)")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--simplify-m", type=float, default=0.5)
    args = ap.parse_args()
    print(f"garmin_import: {GarminImporter(args.export_root, args.db, simplify_tol_m=args.simplify_m).run()}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_import.py -q`
Expected: PASS (2 tests). Then run the whole Python suite: `.venv/bin/python -m pytest ingest -q` → all green.

- [ ] **Step 5: Commit**

```bash
git add ingest/garmin_import.py ingest/tests/test_garmin_import.py
git commit -m "feat: garmin export importer"
```

---

### Task 10: Run the one-shot bulk import (integration)

No new code — this runs the two importers against the real exports to produce `data/activities.sqlite` locally. Committed in Task 11 after the parity gate.

**Files:**
- Produces (untracked until Task 11): `data/activities.sqlite`

- [ ] **Step 1: Import Strava first (establishes Strava-canonical ids)**

```bash
BASE="/mnt/c/Users/Administrator/Desktop/Exported data"
mkdir -p data
PYTHON_BIN=.venv/bin/python npm run import:strava -- "$BASE/Strava"
```
Expected: `strava_import: {'insert': ~490, 'update': 0, 'merge': 0}`.

- [ ] **Step 2: Import Garmin second (merges onto the Strava rows)**

```bash
BASE="/mnt/c/Users/Administrator/Desktop/Exported data"
PYTHON_BIN=.venv/bin/python npm run import:garmin -- "$BASE/Garmin"
```
Expected: mostly `merge` (~352) with ~1 `insert` (the lone Garmin-only activity). If you see hundreds of inserts, the timestamp match is failing — check that Garmin `startTimeGmt` (ms) and FIT `session.start_time` align within ±90 s.

- [ ] **Step 3: Sanity-check the store**

```bash
.venv/bin/python - <<'PY'
import sqlite3
c = sqlite3.connect("data/activities.sqlite")
n, both, gps = c.execute(
  "SELECT COUNT(*), SUM(strava_id IS NOT NULL AND garmin_id IS NOT NULL), SUM(polyline<>'') FROM activities"
).fetchone()
print("activities", n, "in both services", both, "with GPS", gps)
PY
```
Expected: ~491 activities, ~352 in both, ~400+ with GPS. A row count wildly different from ~491 means dedupe over- or under-merged — stop and investigate before committing the DB.

---

### Task 11: Build `tracks.json` from SQLite + wire version 2 + parity gate

**Files:**
- Modify: `scripts/build-tracks.ts` (full rewrite of the read path)
- Modify: `scripts/types.ts` (`ActivityFeatureProps.id` → string)
- Test: `scripts/build-tracks.test.ts`
- Commits: `data/activities.sqlite`

**Interfaces:**
- Consumes: `data/activities.sqlite` (Task 10), `simplifyLngLat` (`scripts/simplify.ts`), `EncodedTrack`/`TrackPayload` (`scripts/types.ts`).
- Produces: `buildTracks(rows: ActivityRow[], stats: Stats) -> EncodedTrack[]` (pure, testable) and `app/public/tracks.json` at payload `v: 2` with namespaced string ids.

- [ ] **Step 1: Snapshot the current output BEFORE editing the build**

```bash
npm run build:tracks           # current build, still reads data/activities.json
cp app/public/tracks.json /tmp/tracks-before.json
node -e "const t=require('/tmp/tracks-before.json');console.log('before v',t.v,'tracks',t.tracks.length)"
```
Expected: `before v 1 tracks 399` (or your current routed count).

- [ ] **Step 2: Widen the id type in the pipeline contract**

In `scripts/types.ts`, change `ActivityFeatureProps.id`:

```ts
  /** Namespaced wire id: "s:<stravaId>" or "g:<garminId>". */
  id: string;
```

(Leave `CachedActivity` in place for now — `scripts/strava.ts`/`sync.ts` still reference it; they're deleted in Task 13.)

- [ ] **Step 3: Write the failing build test**

`scripts/build-tracks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import polyline from "@mapbox/polyline";
import { buildTracks, type ActivityRow } from "./build-tracks.ts";

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "s:111", name: "Run", type: "Run", start_time: "2026-08-01T06:30:00+00:00",
    distance: 1000, moving_time: 600, elevation_gain: 10,
    poly: polyline.encode([[46.0, 14.0], [46.001, 14.001], [46.002, 14.0]]),
    ...over,
  } as ActivityRow;
}

test("builds an encoded track with namespaced id", () => {
  const stats = { rawPoints: 0, keptPoints: 0 };
  const out = buildTracks([row()], stats);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "s:111");
  assert.equal(out[0].elevation_gain, 10);
  assert.ok(out[0].poly.length > 0);
});

test("skips rows with no polyline", () => {
  const out = buildTracks([row({ id: "g:1", poly: "" })], { rawPoints: 0, keptPoints: 0 });
  assert.equal(out.length, 0);
});
```

> Note: `poly` is the column name used only in the test row for convenience; the real query aliases the DB `polyline` column. Match the `ActivityRow` field name you export in Step 4 — use `polyline` in both. Adjust the test's `poly:` to `polyline:` to match.

- [ ] **Step 4: Rewrite `scripts/build-tracks.ts`**

```ts
// Build app/public/tracks.json from the committed SQLite store.
// Reads activities with geometry, simplifies each route (Douglas–Peucker, 5 m)
// and re-encodes it as a Google polyline for the compact wire format. No network.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import polyline from "@mapbox/polyline";
import { simplifyLngLat } from "./simplify.ts";
import type { EncodedTrack, TrackPayload } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, "../data/activities.sqlite");
const OUT_PATH = resolve(__dirname, "../app/public/tracks.json");

/** Wire-format version written to tracks.json (see TrackPayload). */
const PAYLOAD_VERSION = 2;
/** Douglas–Peucker tolerance (meters) applied to the stored line for the wire. */
const SIMPLIFY_TOLERANCE_M = Number(process.env.SIMPLIFY_TOLERANCE_M) || 5;

export interface ActivityRow {
  id: string;
  name: string;
  type: string;
  start_time: string;
  distance: number;
  moving_time: number;
  elevation_gain: number;
  polyline: string;
}

interface Stats {
  rawPoints: number;
  keptPoints: number;
}

function toTrack(a: ActivityRow, stats: Stats): EncodedTrack | null {
  if (!a.polyline) return null; // indoor / manual — no route
  let coords = polyline.decode(a.polyline).map(([lat, lng]) => [lng, lat] as [number, number]);
  if (coords.length < 2) return null;
  stats.rawPoints += coords.length;
  coords = simplifyLngLat(coords, SIMPLIFY_TOLERANCE_M);
  stats.keptPoints += coords.length;
  const poly = polyline.encode(coords.map(([lng, lat]) => [lat, lng] as [number, number]));
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    ts: Math.floor(Date.parse(a.start_time) / 1000),
    start_date: a.start_time,
    distance: a.distance,
    moving_time: a.moving_time,
    elevation_gain: a.elevation_gain,
    poly,
  };
}

/** Pure: rows -> encoded tracks. Exported for tests. */
export function buildTracks(rows: ActivityRow[], stats: Stats): EncodedTrack[] {
  return rows.map((r) => toTrack(r, stats)).filter((t): t is EncodedTrack => t !== null);
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      "SELECT id,name,type,start_time,distance,moving_time,elevation_gain,polyline " +
        "FROM activities WHERE polyline <> '' ORDER BY start_time",
    )
    .all() as ActivityRow[];
  db.close();

  const stats: Stats = { rawPoints: 0, keptPoints: 0 };
  const tracks = buildTracks(rows, stats);
  const payload: TrackPayload = { v: PAYLOAD_VERSION, tracks };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));
  console.log(
    `Wrote ${tracks.length} route tracks; points ${stats.rawPoints} -> ${stats.keptPoints} ` +
      `after ${SIMPLIFY_TOLERANCE_M}m simplify.`,
  );
}

// Only run when executed directly, so tests can import buildTracks without I/O.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the build test (and fix the test's field name)**

Ensure the test's `row()` uses `polyline:` (not `poly:`) to match `ActivityRow`. Run: `npm run test -- build-tracks` (or `npx tsx --test scripts/build-tracks.test.ts`).
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and build from the real DB**

```bash
npm run typecheck
npm run build:tracks
node -e "const t=require('./app/public/tracks.json');console.log('v',t.v,'tracks',t.tracks.length,'sample',t.tracks[0].id)"
```
Expected: no type errors; `v 2`; a track count ≥ the before-count; sample id like `s:...`.

- [ ] **Step 7: Parity gate vs the snapshot**

```bash
node -e "
const before=require('/tmp/tracks-before.json'), after=require('./app/public/tracks.json');
const want=new Set(before.tracks.map(t=>'s:'+t.id));
const have=new Set(after.tracks.map(t=>t.id));
const missing=[...want].filter(id=>!have.has(id));
console.log('before',before.tracks.length,'after',after.tracks.length);
console.log('all namespaced:', after.tracks.every(t=>/^[sg]:/.test(t.id)));
console.log('missing prior routes:', missing.length, missing.slice(0,5));
if(missing.length||after.tracks.length<before.tracks.length){process.exit(1)}
"
```
Expected: `missing prior routes: 0`, `all namespaced: true`, `after ≥ before`. A nonzero `missing` means the import dropped or mis-ided a previously-rendered activity — stop and fix before committing the DB.

- [ ] **Step 8: Commit the store and build**

```bash
git add data/activities.sqlite scripts/build-tracks.ts scripts/build-tracks.test.ts scripts/types.ts
git commit -m "feat: build tracks from sqlite, wire v2 string ids"
```

---

### Task 12: Frontend — string ids and source-aware links

**Files:**
- Modify: `app/src/types.ts`, `app/src/tracks.ts`, `app/src/replay.ts`, `app/src/MapView.tsx`, `app/src/App.tsx`, `app/src/format.ts`, `app/src/ui/InfoPanel.tsx`, `app/src/ui/StatsSection.tsx`
- Test/modify fixtures: `app/src/format.test.ts`, `app/src/tracks.test.ts`, `app/src/replay.test.ts`, `app/src/stats.test.ts`, `app/src/colors.test.ts`, `app/src/cluster.test.ts`

**Interfaces:**
- Consumes: `tracks.json` v2 with string ids (Task 11).
- Produces: `activityLink(id: string): { url: string; label: string } | null` in `app/src/format.ts`; app state keyed on string ids.

> `app/package.json` build is `tsc --noEmit && vite build` and `app/tsconfig.json` includes all of `src`, so every `*.test.ts` fixture is typechecked — the fixtures MUST move with the contract or the build fails.

- [ ] **Step 1: Write the failing link-builder test**

In `app/src/format.test.ts`, add `activityLink` to the import from `./format` and append:

```ts
describe("activityLink", () => {
  test("strava id -> strava url", () => {
    expect(activityLink("s:10089952322")).toEqual({
      url: "https://www.strava.com/activities/10089952322",
      label: "View on Strava",
    });
  });
  test("garmin id -> garmin url", () => {
    expect(activityLink("g:12345678")).toEqual({
      url: "https://connect.garmin.com/modern/activity/12345678",
      label: "View on Garmin Connect",
    });
  });
  test("unknown prefix / malformed -> null", () => {
    expect(activityLink("x:1")).toBeNull();
    expect(activityLink("")).toBeNull();
    expect(activityLink("12345")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace app run test -- format`
Expected: FAIL — `activityLink is not a function`.

- [ ] **Step 3: Implement `activityLink`**

Append to `app/src/format.ts`:

```ts
/**
 * Resolve a namespaced wire id ("s:123" / "g:456") to its source's activity page.
 * Returns null for anything unrecognized so the UI just renders plain text.
 */
export function activityLink(id: string): { url: string; label: string } | null {
  const sep = id.indexOf(":");
  if (sep < 1) return null;
  const raw = id.slice(sep + 1);
  if (!raw) return null;
  if (id[0] === "s") return { url: `https://www.strava.com/activities/${raw}`, label: "View on Strava" };
  if (id[0] === "g") return { url: `https://connect.garmin.com/modern/activity/${raw}`, label: "View on Garmin Connect" };
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace app run test -- format`
Expected: PASS.

- [ ] **Step 5: Widen the frontend contract types**

- `app/src/types.ts:8` — `id: number;` → `id: string;` (update the comment to "namespaced wire id").
- `app/src/tracks.ts:15` — `export const PAYLOAD_VERSION = 1;` → `= 2;`.

- [ ] **Step 6: Update replay id type + tiebreak**

In `app/src/replay.ts`: change `ReplayStep.id` (line 15) and `ReplayFrame.id` (line 25) from `number` to `string`, then change the sort (line 49):

```ts
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
```

- [ ] **Step 7: Update MapView id types + sentinel**

In `app/src/MapView.tsx`:
- Line 41: `const MATCH_NONE: ExpressionSpecification = ["==", ["get", "id"], ""];` (was `-1`).
- Lines 50–53: `hoverId: string | null;`, `selectedId: string | null;`, `onHover: (id: string | null) => void;`, `onSelect: (id: string) => void;`.
- Line 95: `const activeRef = useRef<string | null>(activeId);`.
- Line 167: leave the expression, update its comment to "id (string) as the lexicographic tiebreak — must match buildTimeline's sort".
- Lines 311 and 324: `as number | undefined` → `as string | undefined`.

(`["==", ["get", "id"], active]` at line 119 needs no change — Mapbox compares strings fine.)

- [ ] **Step 8: Update App state + info-panel wiring**

In `app/src/App.tsx`:
- Add `activityLink` to the existing import from `./format`.
- Lines 53–54: `useState<string | null>(null)` for both `selectedId` and `hoverId`.
- Replace the `useMemo` block (lines 226–247):

```ts
  const { title, subtitle, cards, link } = useMemo<{
    title: string;
    subtitle: string;
    cards: StatCard[];
    link: { url: string; label: string } | null;
  }>(() => {
    if (selectedFeature) {
      const p = selectedFeature.properties;
      return {
        title: p.name,
        subtitle: `${p.type} · ${formatDateYear(p.ts)}`,
        cards: activityCards(selectedFeature),
        link: activityLink(p.id),
      };
    }
    return {
      title: "All Activities",
      subtitle: `${formatDate(fromVal)} — ${formatDate(toVal)}`,
      cards: totalCards(filteredFeatures),
      link: null,
    };
  }, [selectedFeature, filteredFeatures, fromVal, toVal]);
```

- Line 329: `stravaUrl={stravaUrl}` → `link={link}`.

- [ ] **Step 9: Update the two panel components**

In `app/src/ui/InfoPanel.tsx`: change the `Props` field `stravaUrl: string | null;` → `link: { url: string; label: string } | null;` and the passthrough to `<StatsSection ... link={p.link} />`.

In `app/src/ui/StatsSection.tsx`: change `Props.stravaUrl?: string | null;` → `link?: { url: string; label: string } | null;`, destructure `link` instead of `stravaUrl`, and replace the anchor:

```tsx
        {link ? (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={link.label}
            style={titleLink}
          >
            {title}
          </a>
        ) : (
```

- [ ] **Step 10: Migrate the typechecked test fixtures**

- `app/src/stats.test.ts:10`, `app/src/colors.test.ts:17`, `app/src/cluster.test.ts:10` — `id: 1` → `id: "s:1"`.
- `app/src/tracks.test.ts` — import `PAYLOAD_VERSION` from `./tracks`; replace every `v: 1` (lines 33, 41, 54, 83, 89) with `v: PAYLOAD_VERSION`; `id: 1` (line 13) → `"s:1"`; `id: 42` (58, 69) → `"s:42"`; `track({ id: 1, ... })`/`track({ id: 2, ... })` (91, 92) → `"s:1"`/`"s:2"`; `toEqual([2])` (95) → `toEqual(["s:2"])`.
- `app/src/replay.test.ts` — `id: 1` (17) → `"s:1"`; every `feature({ id: n, ... })` and expected `{ id: n, ts }` (lines 45–86) → the `"s:<n>"` form. Ids are single-digit, so `"s:1" < "s:2" < "s:5"` lexicographically matches the old numeric order — the tiebreak test still asserts the same sequence.

- [ ] **Step 11: Typecheck, test, and build the app**

```bash
npm --workspace app run test
npm --workspace app run build
```
Expected: all vitest green; `tsc --noEmit && vite build` succeeds (proves every fixture typechecks under the string-id contract).

- [ ] **Step 12: Smoke-test by hand**

```bash
npm run build:tracks && npm --workspace app run dev
```
Click a route → panel shows stats and the title links to Strava (or Garmin). Hover → others dim. Run a replay → routes draw on in date order. This is the regression gate for the id change; it isn't unit-covered.

- [ ] **Step 13: Commit**

```bash
git add app/src
git commit -m "feat: string ids, source-aware activity links"
```

---

### Task 13: Retire the live-poll pipeline, CI, and docs

**Files:**
- Delete: `scripts/strava.ts`, `scripts/get-refresh-token.ts`, `scripts/sync.ts`, `data/activities.json`
- Modify: `scripts/types.ts` (drop `CachedActivity`), `package.json` (scripts), `.github/workflows/deploy.yml`, `.example.env`, `README.md`

**Interfaces:**
- Consumes: everything above (the DB is now the source of truth).
- Produces: a build-only deploy pipeline.

- [ ] **Step 1: Delete the dead live-poll files**

```bash
git rm scripts/strava.ts scripts/get-refresh-token.ts scripts/sync.ts data/activities.json
```

- [ ] **Step 2: Drop the now-unused cache type**

In `scripts/types.ts`, delete the `CachedActivity` interface and its doc comment (nothing imports it after Step 1).

- [ ] **Step 3: Update npm scripts**

In `package.json`, remove `"auth"` and `"sync"`. Keep `import:strava`, `import:garmin`, `build:tracks`, `build`, `typecheck`, `test`, `test:py`. Add a combined test convenience if desired:

```json
    "test": "tsx --test scripts/*.test.ts",
    "test:all": "npm run test && npm run test:py && npm --workspace app run test"
```

- [ ] **Step 4: Rewrite the deploy workflow to build-only**

Replace `.github/workflows/deploy.yml` with:

```yaml
name: Deploy

on:
  push:
    branches: [main]
    paths: ["data/activities.sqlite", "app/**", "scripts/**", ".github/workflows/deploy.yml"]
  workflow_dispatch:

concurrency:
  group: pages
  cancel-in-progress: false

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Build site
        env:
          VITE_MAPBOX_TOKEN: ${{ secrets.VITE_MAPBOX_TOKEN }}
        run: npm run build
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: app/dist
      - id: deploy
        uses: actions/deploy-pages@v5
```

The three `STRAVA_*` repo secrets are now unused (remove them in GitHub settings after this merges). `build` runs `build:tracks` (reads the committed DB) then the app build — no network, no cache commit.

- [ ] **Step 5: Update `.example.env`**

Replace its contents with:

```
VITE_MAPBOX_TOKEN=
```

(Garmin/Strava fetch credentials arrive in the later fetch-phase plan.)

- [ ] **Step 6: Update the README**

Replace any Strava-sync / `npm run auth` / `npm run sync` instructions with the new data flow:

- Data lives in `data/activities.sqlite` (committed source of truth).
- One-shot backfill from bulk exports: `npm run import:strava -- <strava-export>` then `npm run import:garmin -- <garmin-export>` (Strava first). Raw exports are not committed.
- `npm run build` reads the DB → `app/public/tracks.json` → the app; CI deploys on push.
- Note the ongoing Garmin fetch is a later phase (`ingest/garmin_fetch.py` is a stub).

- [ ] **Step 7: Full verification**

```bash
npm run typecheck
npm run build:tracks
.venv/bin/python -m pytest ingest -q
npm run test
npm --workspace app run test
npm run build
```
Expected: all green; `app/dist` produced. This proves the whole path — DB → tracks → app — works with the live-poll code gone.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: retire strava live-poll, build-only deploy, docs"
```

---

## Self-Review

**Spec coverage:** every design section maps to a task — 4 components (T7 bases + T8/T9 importers + fetcher stubs), SQLite schema with `strava_id`/`garmin_id` (T5), ≤0.5 m import simplify (T3), dedupe ±90 s/±5 % + merge policy (T6), FIT/TCX/GPX parsers incl. semicircles + `file_id.type` filter (T4), Garmin scaled units + summary↔FIT match (T9), Strava duplicate-column gotcha (T8), build v2 + parity gate (T11), frontend string ids + `activityLink` (T12), retire `activities.json` + build-only CI (T13).

**Deferred by design (not gaps):** live `garmin_fetch`/`strava_fetch` bodies are stubs (later phase, per spec); `BaseFetcher.high_water` is the only fetch scaffolding built now.

**Type consistency:** `RawActivity`/`Activity` (T2) flow unchanged through normalize (T3) → store (T5) → dedupe (T6) → importers (T8/T9); `ActivityRow`/`buildTracks` (T11) match the DB columns; `activityLink` signature (T12) matches its App consumer.

**Manual gates (not unit-covered):** T10 import counts, T11 parity, T12 hand smoke-test.
