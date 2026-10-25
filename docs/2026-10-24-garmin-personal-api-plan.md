# Garmin Personal API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unofficial `garminconnect` scraper with the official Garmin Connect Personal API while keeping the existing SQLite/store/wire contract unchanged.

**Architecture:** A new stdlib-only `GarminPersonalApi` client exchanges a Personal API key for a bearer token, lists activity summaries, and downloads each new GPS activity's original FIT/TCX/GPX ZIP. `GarminFetcher` maps the list fields to `RawActivity` exactly as today and extracts geometry with the existing parsers; normalize/dedupe/store are untouched.

**Tech Stack:** Python 3.12, stdlib `urllib`/`zipfile`/`sqlite3`, existing `fitdecode`/`gpxpy`/`polyline`, `pytest`, bash, GitHub Actions.

**Spec:** `docs/2026-10-24-garmin-personal-api-design.md`

## Global Constraints

- Keep `RawActivity`, `Activity`, the SQLite schema, `tracks.json`, and the frontend unchanged.
- Personal API list units are **meters and seconds** — do not reuse the bulk export's `/100` or `/1000` scaling.
- Credentials: `--api-key-file` → `GARMIN_PERSONAL_API_KEY` → `~/.config/garmin/connect-personal-api-key`. Never log or commit the key.
- Exit **2** for a missing key and **3** for a rejected/expired key.
- No new Python dependencies; remove `garminconnect==0.3.15` and `curl_cffi==0.16.3`.
- Keep the 1 req/s delay and download files only when `hasPolyline` is true.
- Remove all token-rotation machinery (`GARMIN_TOKEN`, `GARMIN_TOKEN_OUT`, `gh secret set`).
- `GH_PAT` stays for the push that retriggers `deploy.yml`; it no longer needs `secrets: write`.
- Python commands use `${PYTHON_BIN:-python3}`; tests run under the repo `.venv`.
- Commit messages are concise, e.g. `feat: add Garmin Personal API client`.

## Review Focus

- Missing, expired, or revoked key must fail loudly (exit 2/3), never produce a silent zero-activity run.
- Null or missing `activityType`, `movingDuration`, `elevationGain`, and `activityName` must not crash and must not be scaled.
- The download ZIP may contain TCX or GPX instead of FIT, plus extra files; the fetcher must pick a supported file.
- Existing Garmin and Strava rows must not duplicate on the first API run; a rerun above the high-water mark must not re-download.
- CI must not create an empty commit or push when the DB is unchanged, and must not commit after a failed fetch.

---

### Task 1: Garmin Personal API client

**Files:**
- Create: `ingest/garmin_api.py`
- Create: `ingest/tests/test_garmin_api.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolve_api_key(api_key: str | None = None, *, key_file: str | None = None) -> str`
  - `GarminPersonalApi(*, api_key=None, key_file=None, base_url=None, timeout=30.0, opener=None)`
  - `GarminPersonalApi.authenticate() -> None`
  - `GarminPersonalApi.list_activities(start: int = 0, limit: int = 100) -> list[dict]`
  - `GarminPersonalApi.download_activity(activity_id: int | str) -> bytes`
  - `GarminApiError(message, *, status=None, url=None)`, `MissingApiKey`, `GarminAuthError`
  - Constants: `BASE_URL`, `TOKEN_PATH`, `API_KEY_ENV`, `BASE_URL_ENV`, `DEFAULT_KEY_FILE`, `USER_AGENT`

- [ ] **Step 1: Create the test environment**

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python \
  fitdecode==0.11.0 gpxpy==1.6.2 polyline==2.0.4 pytest==9.1.1
```

- [ ] **Step 2: Write the failing client tests**

`ingest/tests/test_garmin_api.py` must cover credential precedence, the token
request, bearer GETs, and typed errors. Use a fake opener; no network.

```python
import io
import urllib.error

import pytest

from ingest import garmin_api as ga


class FakeResponse:
    def __init__(self, body): self.body = body
    def read(self): return self.body
    def __enter__(self): return self
    def __exit__(self, *exc): return False


class FakeOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return FakeResponse(result)


def _api(opener):
    return ga.GarminPersonalApi(
        api_key="secret", base_url="https://api.test", opener=opener
    )


def _http_error(code, body=b"denied"):
    return urllib.error.HTTPError(
        "https://api.test/x", code, "boom", {}, io.BytesIO(body)
    )


def test_resolve_prefers_explicit_key(monkeypatch):
    monkeypatch.setenv("GARMIN_PERSONAL_API_KEY", "env")
    assert ga.resolve_api_key(" explicit ") == "explicit"


def test_resolve_reads_explicit_key_file(tmp_path, monkeypatch):
    monkeypatch.setenv("GARMIN_PERSONAL_API_KEY", "env")
    path = tmp_path / "key"
    path.write_text(" file-key \n")
    assert ga.resolve_api_key(key_file=str(path)) == "file-key"


def test_resolve_explicit_missing_file_does_not_fall_back(tmp_path, monkeypatch):
    monkeypatch.setenv("GARMIN_PERSONAL_API_KEY", "env")
    with pytest.raises(ga.MissingApiKey):
        ga.resolve_api_key(key_file=str(tmp_path / "missing"))


def test_resolve_env_then_default_file(tmp_path, monkeypatch):
    monkeypatch.delenv("GARMIN_PERSONAL_API_KEY", raising=False)
    monkeypatch.setattr(ga, "DEFAULT_KEY_FILE", str(tmp_path / "key"))
    with pytest.raises(ga.MissingApiKey):
        ga.resolve_api_key()
    (tmp_path / "key").write_text("default-key")
    assert ga.resolve_api_key() == "default-key"


def test_authenticate_posts_api_key_and_strips_token():
    opener = FakeOpener(b"jwt.token.value\n")
    api = _api(opener)
    api.authenticate()
    request, _ = opener.requests[0]
    assert request.full_url == "https://api.test" + ga.TOKEN_PATH
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "ApiKey secret"
    assert api._token == "jwt.token.value"


def test_list_activities_uses_bearer_and_query_params():
    opener = FakeOpener(b"jwt", b'[{"activityId": 1}]')
    api = _api(opener)
    assert api.list_activities(0, 100) == [{"activityId": 1}]
    request, _ = opener.requests[1]
    assert request.full_url == (
        "https://api.test/activitylist-service/activities/search/activities"
        "?start=0&limit=100"
    )
    assert request.get_header("Authorization") == "Bearer jwt"
    assert request.get_header("Accept") == "application/json"


def test_download_activity_returns_bytes_and_accepts_zip():
    opener = FakeOpener(b"jwt", b"PK\x03\x04zip")
    api = _api(opener)
    assert api.download_activity(123) == b"PK\x03\x04zip"
    request, _ = opener.requests[1]
    assert request.full_url == "https://api.test/download-service/files/activity/123"
    assert "zip" in request.get_header("Accept")


def test_download_activity_rejects_non_numeric_id():
    with pytest.raises(ValueError):
        _api(FakeOpener()).download_activity("abc")


def test_token_401_raises_auth_error():
    api = _api(FakeOpener(_http_error(401)))
    with pytest.raises(ga.GarminAuthError) as exc:
        api.authenticate()
    assert exc.value.status == 401


def test_list_500_raises_api_error():
    api = _api(FakeOpener(b"jwt", _http_error(500)))
    with pytest.raises(ga.GarminApiError) as exc:
        api.list_activities()
    assert exc.value.status == 500


def test_list_non_list_payload_raises():
    api = _api(FakeOpener(b"jwt", b'{"not": "a list"}'))
    with pytest.raises(ga.GarminApiError):
        api.list_activities()
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_api.py -q`
Expected: `ModuleNotFoundError: No module named 'ingest.garmin_api'`.

- [ ] **Step 4: Implement `ingest/garmin_api.py`**

Use `urllib.request` only. The client must:

- resolve the key in this order: explicit `api_key`, explicit `key_file`, env
  `GARMIN_PERSONAL_API_KEY`, default `~/.config/garmin/connect-personal-api-key`
- strip whitespace from keys and tokens
- POST the token request with `Authorization: ApiKey <key>` and `Accept: */*`
- send `Authorization: Bearer <token>` on data requests
- map HTTP 401/403 to `GarminAuthError` and other HTTP/network failures to
  `GarminApiError` with `status` and `url`
- send `User-Agent: strava-on-maps/0.1`
- honor `GARMIN_PERSONAL_API_BASE_URL` for tests/local overrides
- raise `ValueError` for a non-numeric activity id

- [ ] **Step 5: Run the tests and verify they pass**

Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_api.py -q`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add ingest/garmin_api.py ingest/tests/test_garmin_api.py
git commit -m "feat: add Garmin Personal API client"
```

---

### Task 2: Rewrite the Garmin fetcher

**Files:**
- Modify: `ingest/garmin_fetch.py` (full rewrite of the auth/geometry parts)
- Modify: `ingest/tests/test_garmin_fetch.py` (full rewrite)
- Modify: `ingest/tests/test_base.py:56-62`
- Delete: `ingest/garmin_auth.py`
- Delete: `ingest/tests/fixtures/garmin_api_detail.json`

**Interfaces:**
- Consumes: `GarminPersonalApi`, `MissingApiKey`, `GarminAuthError` from Task 1.
- Produces:
  - `gmt_to_dt(s: str) -> datetime`
  - `gmt_to_epoch(s: str) -> int`
  - `filter_after(items: list[dict], after_epoch: int) -> list[dict]`
  - `extract_track_from_zip(data: bytes) -> list[tuple[float, float]]`
  - `list_item_to_raw(item: dict, track: list[tuple[float, float]]) -> RawActivity`
  - `GarminFetcher(db_path, *, delay_s=1.0, client=None, key_file=None, page_size=100, **kw)`
  - `GarminFetcher.authenticate() -> GarminPersonalApi`

- [ ] **Step 1: Write the failing fetcher tests**

Keep the existing fixture `garmin_api_list.json` as the list payload. Build ZIP
downloads in memory from the existing `outdoor.fit` and `sample.tcx` fixtures.

```python
import io
import json
import os
import zipfile

import pytest

from ingest import garmin_fetch as gf
from ingest.garmin_api import GarminAuthError
from ingest.model import RawActivity
from ingest.parse.fit import parse_fit

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _list():
    with open(os.path.join(FIX, "garmin_api_list.json")) as fh:
        return json.load(fh)


def _fixture_bytes(name):
    with open(os.path.join(FIX, name), "rb") as fh:
        return fh.read()


def _zip(*names):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name in names:
            zf.writestr(f"activity{os.path.splitext(name)[1]}", _fixture_bytes(name))
    return buf.getvalue()


class FakeClient:
    def __init__(self, items, download):
        self.items, self.download = items, download
        self.list_calls, self.download_calls = [], []

    def list_activities(self, start, limit):
        self.list_calls.append((start, limit))
        return self.items if start == 0 else []

    def download_activity(self, activity_id):
        self.download_calls.append(activity_id)
        if isinstance(self.download, Exception):
            raise self.download
        return self.download


def test_extract_track_from_zip_reads_fit():
    assert gf.extract_track_from_zip(_zip("outdoor.fit"))


def test_extract_track_from_zip_reads_tcx():
    assert gf.extract_track_from_zip(_zip("sample.tcx")) == [
        (46.05, 14.5),
        (46.051, 14.501),
    ]


def test_extract_track_from_zip_reads_gpx():
    assert gf.extract_track_from_zip(_zip("sample.gpx")) == [
        (46.05, 14.5),
        (46.051, 14.501),
        (46.052, 14.502),
    ]


def test_extract_track_from_zip_prefers_fit():
    track = gf.extract_track_from_zip(_zip("sample.tcx", "outdoor.fit"))
    assert len(track) == len(parse_fit(io.BytesIO(_fixture_bytes("outdoor.fit"))).track)


def test_extract_track_from_zip_rejects_unknown_file():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "nope")
    with pytest.raises(ValueError):
        gf.extract_track_from_zip(buf.getvalue())


def test_gmt_to_dt_is_utc():
    dt = gf.gmt_to_dt("2026-09-12 06:30:00")
    assert dt.tzinfo is not None and dt.utcoffset().total_seconds() == 0
    assert gf.gmt_to_epoch("2026-09-12 06:30:00") == int(dt.timestamp())


def test_filter_after_is_strictly_after():
    items = _list()
    boundary = gf.gmt_to_epoch("2026-09-12 06:30:00")
    assert gf.filter_after(items, boundary) == []
    assert [i["activityId"] for i in gf.filter_after(items, boundary - 1)] == [5000001]


def test_list_item_to_raw_no_unit_scaling():
    outdoor, indoor = _list()
    raw = gf.list_item_to_raw(outdoor, [(46.05, 14.5)])
    assert isinstance(raw, RawActivity)
    assert raw.source == "garmin" and raw.source_id == "5000001"
    assert raw.type_raw == "running" and raw.name == "Morning Run"
    assert raw.distance_m == 10006.79 and raw.elevation_gain_m == 34.0
    assert raw.moving_time_s == 3200
    assert raw.start_time.year == 2026 and raw.start_time.month == 9
    assert raw.track == [(46.05, 14.5)]
    assert raw.source_file == "garmin-personal-api"


def test_list_item_to_raw_fallbacks():
    raw = gf.list_item_to_raw({"activityId": 1, "startTimeGMT": "2026-09-12 06:30:00"}, [])
    assert raw.type_raw == "other"
    assert raw.name == "" and raw.distance_m == 0.0
    assert raw.moving_time_s == 0 and raw.elevation_gain_m == 0.0


def test_run_inserts_with_geometry_and_windows_on_rerun(tmp_path):
    from ingest import store

    db = str(tmp_path / "db.sqlite")
    client = FakeClient(_list(), _zip("outdoor.fit"))
    fetcher = gf.GarminFetcher(db, delay_s=0, client=client)
    assert fetcher.run() == {"insert": 2, "update": 0, "merge": 0}

    conn = store.connect(db)
    run = store.find_by_service_id(conn, "garmin", "5000001")
    gym = store.find_by_service_id(conn, "garmin", "5000002")
    assert run.type == "Run" and run.polyline != ""
    assert run.distance == 10006.79 and run.moving_time == 3200
    assert gym.polyline == ""
    assert client.download_calls == [5000001]
    conn.close()

    client2 = FakeClient(_list(), _zip("outdoor.fit"))
    assert gf.GarminFetcher(db, delay_s=0, client=client2).run() == {
        "insert": 0, "update": 0, "merge": 0
    }
    assert client2.download_calls == []


def test_download_failure_is_not_persisted_and_retried(tmp_path):
    import warnings
    from ingest import store

    db = str(tmp_path / "db.sqlite")
    bad = FakeClient(_list(), RuntimeError("boom"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert gf.GarminFetcher(db, delay_s=0, client=bad).run() == {
            "insert": 1, "update": 0, "merge": 0
        }
    conn = store.connect(db)
    assert store.find_by_service_id(conn, "garmin", "5000001") is None
    assert store.find_by_service_id(conn, "garmin", "5000002") is not None
    conn.close()

    good = FakeClient(_list(), _zip("outdoor.fit"))
    assert gf.GarminFetcher(db, delay_s=0, client=good).run() == {
        "insert": 1, "update": 0, "merge": 0
    }


def test_auth_error_during_download_aborts(tmp_path):
    client = FakeClient(_list(), GarminAuthError("401"))
    with pytest.raises(GarminAuthError):
        gf.GarminFetcher(str(tmp_path / "db.sqlite"), delay_s=0, client=client).run()


def test_missing_key_exits_2(tmp_path, monkeypatch):
    monkeypatch.delenv("GARMIN_PERSONAL_API_KEY", raising=False)
    fetcher = gf.GarminFetcher(str(tmp_path / "db.sqlite"),
                               key_file=str(tmp_path / "missing"))
    with pytest.raises(SystemExit) as exc:
        list(fetcher.activities())
    assert exc.value.code == 2


def test_rejected_key_exits_3(tmp_path, monkeypatch):
    class FakeApi:
        def __init__(self, **kw): pass
        def authenticate(self): raise GarminAuthError("401")

    monkeypatch.setattr(gf, "GarminPersonalApi", FakeApi)
    fetcher = gf.GarminFetcher(str(tmp_path / "db.sqlite"))
    with pytest.raises(SystemExit) as exc:
        fetcher.authenticate()
    assert exc.value.code == 3
```

Also update `ingest/tests/test_base.py::test_fetcher_exits_without_creds` to
pass `key_file=str(tmp_path / "missing")` and clear `GARMIN_PERSONAL_API_KEY`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_fetch.py ingest/tests/test_base.py -q`
Expected: import errors / missing `extract_track_from_zip` / old `GARMIN_TOKEN` behavior.

- [ ] **Step 3: Implement the ZIP track extraction**

Replace `ingest/garmin_fetch.py` with:

- `PAGE_SIZE = 100`, `MAX_CONSECUTIVE_FAILURES = 3`.
- `gmt_to_dt` → `datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)`.
- `extract_track_from_zip(data: bytes) -> list[tuple[float, float]]`:
  - open `zipfile.ZipFile(io.BytesIO(data))`
  - ignore directory entries and `__MACOSX/`
  - try `.fit` first, then `.tcx`, then `.gpx`
  - delegate to `parse_fit` / `parse_tcx` / `parse_gpx`
  - raise `ValueError` when no supported file exists

Run: `.venv/bin/python -m pytest ingest/tests/test_garmin_fetch.py -q -k extract`
Expected: the extraction tests pass.

- [ ] **Step 4: Implement the fetcher and auth**

- `GarminFetcher(db_path, *, delay_s=1.0, client=None, key_file=None, page_size=100, **kw)`.
- `GarminFetcher.authenticate()`:
  - lazily construct `GarminPersonalApi(key_file=self._key_file)` unless a
    client was injected
  - map `MissingApiKey` to `SystemExit(2)` and `GarminAuthError` to
    `SystemExit(3)`, printing an actionable message to stderr
- `GarminFetcher.activities()`:
  - keep the existing high-water/pagination loop, using `client.list_activities(offset, page_size)`
  - download only when `hasPolyline`
  - on download/parse failure: warn, count, skip; three consecutive failures stop
  - re-raise `GarminAuthError` instead of treating it as a transient failure
- `main()`: add `--api-key-file`, call `fetcher.authenticate()` before
  `run()`, and remove all `GARMIN_TOKEN_OUT` logic.

Delete `ingest/garmin_auth.py` and `ingest/tests/fixtures/garmin_api_detail.json`.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `.venv/bin/python -m pytest ingest -q`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add ingest/garmin_fetch.py ingest/tests/test_garmin_fetch.py \
  ingest/tests/test_base.py
git rm ingest/garmin_auth.py ingest/tests/fixtures/garmin_api_detail.json
git commit -m "feat: fetch Garmin activities from the Personal API"
```

---

### Task 3: CI script and workflow

**Files:**
- Modify: `scripts/ci_fetch.sh`
- Modify: `.github/workflows/fetch-garmin.yml`
- Modify: `ingest/tests/test_ci_fetch.py`

**Interfaces:**
- Consumes: `python -m ingest.garmin_fetch --db <path>`.
- Produces: a script that commits/pushes only when the DB changes; no secret
  writes and no token rotation.

- [ ] **Step 1: Rewrite the failing CI tests**

Replace `_stub_python` and both tests with:

```python
def _stub_python(tmp_path, body):
    path = tmp_path / "pybin"
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(0o755)
    return str(path)


def test_dry_run_commits_and_pushes_when_db_changed(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ, "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path,
                                      "printf x >> data/activities.sqlite\n")}
    out = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                         capture_output=True, text=True, check=True).stdout
    assert "DRY: git commit -m chore: garmin fetch" in out
    assert "DRY: git push" in out
    assert "gh secret" not in out


def test_dry_run_no_commit_when_db_unchanged(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ, "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path, "true\n")}
    out = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                         capture_output=True, text=True, check=True).stdout
    assert "no DB change" in out
    assert "DRY: git push" not in out


def test_fetch_failure_aborts_before_commit(tmp_path):
    repo = _repo(tmp_path)
    env = {**os.environ, "DRY_RUN": "1",
           "PYTHON_BIN": _stub_python(tmp_path, "exit 1\n")}
    result = subprocess.run(["bash", SCRIPT], cwd=repo, env=env,
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert "DRY: git commit" not in result.stdout
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `.venv/bin/python -m pytest ingest/tests/test_ci_fetch.py -q`
Expected: the old script still performs token rotation / assertions fail.

- [ ] **Step 3: Update `scripts/ci_fetch.sh`**

Remove step 2 (the `GARMIN_TOKEN_OUT` / `gh secret set` block). Keep the fetch,
the `git diff` check, and the commit/push block. Update the header comment to
say the key is read from `GARMIN_PERSONAL_API_KEY` or the key file.

- [ ] **Step 4: Update `.github/workflows/fetch-garmin.yml`**

Replace the fetch step's env with:

```yaml
        env:
          GARMIN_PERSONAL_API_KEY: ${{ secrets.GARMIN_PERSONAL_API_KEY }}
```

Remove `GARMIN_TOKEN_OUT` and `GH_TOKEN`. Rename the step to
`Fetch and commit`. Keep `token: ${{ secrets.GH_PAT }}` on checkout.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `.venv/bin/python -m pytest ingest/tests/test_ci_fetch.py -q`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci_fetch.sh .github/workflows/fetch-garmin.yml \
  ingest/tests/test_ci_fetch.py
git commit -m "ci: use the Garmin Personal API key without token rotation"
```

---

### Task 4: Remove scraper dependencies and update docs

**Files:**
- Modify: `requirements.txt`
- Modify: `package.json`
- Modify: `README.md`
- Verify deleted: `ingest/garmin_auth.py`, `ingest/tests/fixtures/garmin_api_detail.json`

- [ ] **Step 1: Remove the dependencies and npm script**

`requirements.txt` becomes:

```
fitdecode==0.11.0
gpxpy==1.6.2
polyline==2.0.4
pytest==9.1.1
```

Remove the `"auth": "${PYTHON_BIN:-python3} -m ingest.garmin_auth"` entry from
`package.json`.

- [ ] **Step 2: Rewrite the README “Live Garmin fetch” section**

Replace the token bootstrap/rotation text with:

- why the official Personal API is used
- one-time key creation at Garmin Connect → Settings → Personal API Key
- key lifetime choices (30/90/180/365 days) and renewal
- local setup via `~/.config/garmin/connect-personal-api-key` (chmod 600) or
  `GARMIN_PERSONAL_API_KEY`
- `npm run fetch:garmin`
- CI secret `GARMIN_PERSONAL_API_KEY`, no token rotation
- `GH_PAT` with **contents: write only** (drop `secrets: write`)

Also remove the stale sentence saying the incremental fetch “is a later phase —
for now it's a stub.”

- [ ] **Step 3: Run the full suite**

```bash
uv pip install --python .venv/bin/python -r requirements.txt
PYTHON_BIN=.venv/bin/python pnpm test:all
```

Expected: Python, Node, and app tests all pass.

- [ ] **Step 4: Commit**

```bash
git add requirements.txt package.json README.md
git commit -m "docs: document Garmin Personal API setup"
```

---

### Task 5: Live verification against the real API

**Files:** none (verification only).

**Prerequisite:** the user must save a valid key to
`~/.config/garmin/connect-personal-api-key` (`chmod 600`). Do not paste the key
into the repo or logs.

- [ ] **Step 1: Prove auth and the activity payload**

Run a read-only probe with the client:

```bash
.venv/bin/python - <<'PY'
from ingest.garmin_api import GarminPersonalApi
from ingest.garmin_fetch import extract_track_from_zip

api = GarminPersonalApi()
api.authenticate()
items = api.list_activities(0, 20)
print("activities:", len(items))
for item in items:
    print(item["activityId"], item.get("startTimeGMT"), item.get("activityType", {}).get("typeKey"),
          item.get("distance"), item.get("elevationGain"), item.get("hasPolyline"))
gps = next(i for i in items if i.get("hasPolyline"))
track = extract_track_from_zip(api.download_activity(gps["activityId"]))
print("gps track points:", len(track), "first:", track[0], "last:", track[-1])
PY
```

Expected: a non-empty list, and a non-empty track for the GPS activity.

- [ ] **Step 2: Fetch twice into a copy of the committed DB**

```bash
cp data/activities.sqlite /tmp/opencode/activities-verify.sqlite
.venv/bin/python -m ingest.garmin_fetch --db /tmp/opencode/activities-verify.sqlite
.venv/bin/python -m ingest.garmin_fetch --db /tmp/opencode/activities-verify.sqlite
```

Expected: the first run reports only genuinely new activities; the second
reports `{'insert': 0, 'update': 0, 'merge': 0}`.

- [ ] **Step 3: Check for duplicates and compare fields**

```bash
.venv/bin/python - <<'PY'
import sqlite3
conn = sqlite3.connect("/tmp/opencode/activities-verify.sqlite")
print(conn.execute(
    "select count(*), count(distinct garmin_id) from activities where garmin_id is not null"
).fetchone())
print(conn.execute(
    "select id, name, type, start_time, distance, moving_time, elevation_gain, length(polyline) "
    "from activities where garmin_id is not null order by start_time desc limit 3"
).fetchall())
PY
```

Expected: `count(*) == count(distinct garmin_id)` and the newest rows match the
committed DB for name/type/time/distance/time/elevation.

- [ ] **Step 4: Re-run the suite after cleanup**

```bash
PYTHON_BIN=.venv/bin/python pnpm test:all
```

Expected: all tests pass with `garminconnect` and `curl_cffi` no longer
installed.

- [ ] **Step 5: Record the results**

Put the probe output and the duplicate check in the PR body under
“Verification”. If the download does not yield a usable track for an activity
flagged `hasPolyline`, stop and revisit the design before merging.
