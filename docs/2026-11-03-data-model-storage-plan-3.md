# v2 Data Plan 3: R2 archive, writer cycle, sync and CI cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The archive and the database live in a private Cloudflare R2 bucket.
Every writer pulls the database, writes, and uploads it back with `If-Match`.
The daily fetch stops committing to git and triggers the deploy. Deploy builds
from R2, or from a demo/empty database on a fork without R2. Then the owner
migrates and the site switches to v2.

**Architecture:**
- **Object store:** a small `ObjectStore` interface (`ingest/objstore.py`) has
  two implementations. `S3Store` wraps boto3 against R2's S3 endpoint.
  `MemoryStore` is an in-process fake with real ETag/precondition semantics,
  used by every test.
- **Remote archive:** `RemoteArchive` is a `LocalArchive` over a cache folder
  that writes each key to the store first, then to the cache. So the cache
  never holds a key R2 lacks. Reads fill the cache on demand. The existing
  `Archive` protocol is unchanged, so the engine, importers and fetch don't
  change.
- **Writer cycle:** `ingest/writer.py` wraps every database-writing CLI
  (imports, fetch, rebuild, manual fixes):
  1. pull `db/activities.sqlite` and its ETag;
  2. run the work on a temp copy;
  3. upload with `If-Match`;
  4. on `412`, redo, at most 3 attempts;
  5. write the day's snapshot and prune old ones.
  With a local archive, it just runs the work on `--db`, as today.
- **Display bridge:** until Plan 4, `tracks.json` drops invisible activities
  and carries each activity's provider links. The app shows one link per
  source.

**Tech Stack:** Python 3.12, boto3 (new, for R2), the existing stdlib/fitdecode
code. GitHub Actions with the preinstalled AWS CLI for the deploy pull. Node 22,
TypeScript, Vitest for the bridge.

**Spec:** `docs/2026-10-27-data-model-storage-design.md`, especially
Architecture, R2 layout, Storage backends, Writers, Readers, CI changes and
Migration from v1. Plans 1 and 2 (`docs/2026-10-27-data-model-storage-plan-1.md`,
`docs/2026-10-28-data-model-storage-plan-2.md`) are implemented on this branch.

This is plan 3 of 4. Plan 4 is display files and the app.

## Global Constraints

- **Branch:** keep working on `t3/data-model-dedupe-storage`. The branch merges
  to `main` only in Task 7, after the migration. Until then `main`'s daily v1
  fetch keeps running.
- **R2 layout** (spec): `exports/<provider>/<YYYY-MM-DD>-<name>.zip`,
  `raw/<sha256>`, `db/activities.sqlite`, `db/snapshots/<YYYY-MM-DD>.sqlite`.
  Plans 1–2 added `records/…` and `wellness/…` keys (see `ingest/archive.py`).
  They keep their exact layout in R2.
- **R2 secrets / `.env` names** (spec): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. The deploy uses a separate read-only
  pair: `R2_RO_ACCESS_KEY_ID`, `R2_RO_SECRET_ACCESS_KEY`.
- **Endpoint:** `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, region
  `auto`. boto3 and the AWS CLI must set request checksum calculation and
  response checksum validation to `when_required`. R2 rejects the default
  CRC32 trailers of boto3 ≥ 1.36 / AWS CLI ≥ 2.23.
- **Retries:** "Give up after 3 attempts." `WRITE_ATTEMPTS = 3`.
- **Snapshot retention** (spec): "keep the last 30 daily snapshots plus the
  first snapshot of each month, forever." `SNAPSHOT_DAYS = 30`.
- **"R2 is the only way to publish your own data. No mode commits the database
  to git."** After Task 6, nothing in CI writes to the repo.
- **"Personal data … lands in git or on the public site by accident"** is an
  anti-goal. Hidden and deleted activities never reach `tracks.json`.
- **"A template fork cannot deploy without a Cloudflare account"** is an
  anti-goal. Without R2 secrets, deploy builds from
  `data/demo/activities.sqlite` if present. Otherwise it builds an empty site.
  The demo dataset itself is §6's job.
- **The Garmin API client stays stdlib-only** (`ingest/garmin_api.py`). boto3
  is imported only by `ingest/objstore.py`, lazily.
- **Exit codes:** existing 2 (no key), 3 (key rejected), 4 (v1 database). New:
  - **5:** R2 kept rejecting the upload (`412` on all 3 attempts).
  - **6:** R2 has no database and `--init-db` was not passed.
- **Python tests** run against `MemoryStore`. They never touch the network or
  the developer's `.env` R2 credentials. The one live R2 test is opt-in
  (`R2_LIVE_TEST=1`).

## Review Focus

The inputs most likely to hurt a real user that no happy-path test exercises.
Each one has a test in the task named.

1. **Two writers overlap** (a laptop import while the CI fetch runs) → the
   loser gets `412`, re-pulls and redoes its work. Both changes end up in R2,
   and nothing is lost (Task 3).
2. **R2 has no database** (wrong bucket, or the workflow runs before the
   migration) → the fetch exits 6 and uploads nothing. It never publishes a
   fresh 30-day database over the real history. Only an import with
   `--init-db` creates one (Task 3).
3. **A hidden or deleted activity** → absent from `tracks.json`, including a
   merged activity whose Garmin source was deleted but whose Strava source is
   live (it stays, with only the Strava link) (Task 5).
4. **An upload to R2 fails mid-run** (network error after some blobs) → the
   cache holds nothing R2 lacks. The next run re-uploads the missing keys, and
   the database in R2 is untouched (Task 2, Task 3).
5. **The developer's `.env` has R2 credentials** → the test suite and any
   command given `--archive file://…` never contact R2 (Task 2).

---

### Task 1: Object store

**Files:**
- Create: `ingest/objstore.py`, `ingest/config.py`, `ingest/tests/test_objstore.py`, `ingest/tests/test_objstore_live.py`
- Modify: `ingest/garmin_api.py` (`_read_dotenv_key` uses `config.dotenv_value`), `requirements.txt`, `.example.env`

**Interfaces:**
- Produces:
  - `config.DOTENV_FILE`: the repo-root `.env` path. It moves here from
    `garmin_api.py`, which re-exports it. Tests monkeypatch it.
  - `config.env(name: str) -> str | None`: `os.environ[name]` if non-empty,
    else the value from the repo-root `.env` (same parsing as today's
    `_read_dotenv_key`: `export ` prefix, matching quotes stripped), else
    `None`.
  - `config.dotenv_value(path: str, name: str) -> str | None`: the shared
    parser.
  - `objstore.PreconditionFailed(Exception)`.
  - `objstore.ObjectStore` (Protocol):
    - `get(key: str) -> tuple[bytes, str]`: (data, etag). Raises `KeyError`
      when absent.
    - `head(key: str) -> dict | None`: `{"size": int, "etag": str, "metadata": dict[str, str]}`.
    - `put(key: str, data: bytes, *, if_match: str | None = None, if_none_match: str | None = None, metadata: dict[str, str] | None = None) -> str`:
      returns the new etag. Raises `PreconditionFailed`.
    - `put_file(key: str, path: str, *, metadata: dict[str, str] | None = None) -> None`:
      unconditional, multipart-capable.
    - `list(prefix: str) -> list[tuple[str, int]]`: (key, size), sorted by
      key.
    - `delete(key: str) -> None`.
  - `objstore.MemoryStore()`: implements the protocol. The etag is
    `'"' + md5(data).hexdigest() + '"'`. `if_none_match="*"` fails when the
    key exists. `if_match` fails when the key is absent or its etag differs.
  - `objstore.S3Store(bucket: str, *, account_id: str, access_key_id: str, secret_access_key: str, client=None)`.
  - `objstore.store_from_env(*, read_only: bool = False) -> S3Store | None`:
    - `None` unless `R2_BUCKET` and the credentials are set (via
      `config.env`);
    - `read_only` picks the `R2_RO_*` pair.

- [ ] **Step 1: Write the failing tests** in `test_objstore.py`:
  - `test_memory_put_get_roundtrip`: `put("a", b"x")` returns an etag equal to
    `get("a")[1]`; `get("missing")` raises `KeyError`.
  - `test_memory_if_none_match_star`: the second `put("a", b"y", if_none_match="*")`
    raises `PreconditionFailed`, and `get("a")[0] == b"x"`.
  - `test_memory_if_match`: `put` with the current etag succeeds and returns a
    new etag. `put` with the old etag raises. `put("absent", b"", if_match='"x"')`
    raises.
  - `test_memory_list_and_head`:
    - `list("raw/")` returns only `raw/` keys, sorted, with sizes;
    - `head` returns the metadata given to `put`;
    - `head("missing") is None`.
  - `test_s3store_maps_if_match_and_412`: use `botocore.stub.Stubber` on a
    real boto3 client.
    - Expect `put_object` with
      `{"Bucket": "b", "Key": "db/activities.sqlite", "Body": ANY, "IfMatch": '"e1"'}`.
      A stubbed `PreconditionFailed` (HTTP 412) client error raises
      `objstore.PreconditionFailed`.
    - A stubbed `ConditionalRequestConflict` (HTTP 409) also raises
      `PreconditionFailed`.
  - `test_s3store_head_404_is_none`: a stubbed `head_object` 404 returns
    `None`.
  - `test_store_from_env_needs_bucket_and_keys`: with `monkeypatch` clearing
    the env and `config.DOTENV_FILE` pointed at an empty temp file → `None`.
    With all four set → an `S3Store` whose endpoint is
    `https://acc.r2.cloudflarestorage.com`. With `read_only=True` it uses the
    `R2_RO_*` values.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_objstore.py -q`. Expected:
  FAIL (`ingest.objstore` not found).

- [ ] **Step 3: Implement.**
  - **Dependency:** add boto3 to `requirements.txt`, pinned with `==` to the
    current release (≥ 1.36, which has `IfMatch` on `put_object`).
  - **`S3Store` client config:**
    `botocore.config.Config(region_name="auto", request_checksum_calculation="when_required", response_checksum_validation="when_required", retries={"max_attempts": 5, "mode": "standard"})`.
  - **`S3Store` calls:**
    - `put_file` uses `upload_file` with `ExtraArgs={"Metadata": …}`;
    - `list` pages `list_objects_v2`.
  - **`config.py`:** move the `.env` parser out of `garmin_api.py`.
    `garmin_api._read_dotenv_key(path)` becomes
    `config.dotenv_value(path, API_KEY_ENV)`, so its tests stay green.
  - **`.example.env`:** add the four `R2_*` names, commented, with one line
    saying they are optional and that without them everything stays in
    `data/archive/`.

- [ ] **Step 4: Add the opt-in live test** `test_objstore_live.py`.
  - Mark the module `pytest.mark.skipif(os.environ.get("R2_LIVE_TEST") != "1", reason="live R2 test")`.
  - Against `store_from_env()`, under the prefix `test/<uuid4>/`:
    - `put` then `get`;
    - `if_none_match="*"` on an existing key raises `PreconditionFailed`;
    - a stale `if_match` raises `PreconditionFailed`;
    - `head` returns the metadata;
    - `list(prefix)` sees both keys.
  - Delete every key in a `finally`.
  - This checks R2's real conditional-write semantics and the checksum config.
    Task 7 runs it.

- [ ] **Step 5: Run the whole Python suite.**
  Run: `.venv/bin/python -m pytest ingest -q`. Expected: all pass, with the
  live test skipped.

- [ ] **Step 6: Commit.** `git commit -m "feat: add an R2 object store with conditional writes"`

---

### Task 2: Remote archive with a local cache

**Files:**
- Modify: `ingest/archive.py`, `ingest/tests/test_archive.py`
- Create: `ingest/tests/conftest.py`
- Modify: `.gitignore` (`data/cache/`)

**Interfaces:**
- Consumes: `ObjectStore`, `MemoryStore`, `store_from_env` (Task 1).
- Produces:
  - `archive.RemoteArchive(store: ObjectStore, cache_root: str)`: implements
    `Archive`. It exposes `.store`.
  - `archive.DEFAULT_CACHE = "data/cache"`.
  - `archive.open_archive(url: str | None = None) -> Archive`. Resolution
    order:
    1. `url`;
    2. env `ARCHIVE_URL`;
    3. `r2://<R2_BUCKET>` when `store_from_env()` is not `None`;
    4. `file://data/archive`.
    `r2://<bucket>` opens a `RemoteArchive(store_from_env(), DEFAULT_CACHE)`.
    It raises `ValueError` when the credentials are missing or the bucket
    differs from `R2_BUCKET`.
  - `archive.is_remote(a: Archive) -> bool`.

- [ ] **Step 1: Write the failing tests.**
  - **Shared tests:** parametrize the existing `test_archive.py` tests over an
    `archive` fixture with two params:
    - `local` → `LocalArchive(tmp_path / "a")`;
    - `remote` → `RemoteArchive(MemoryStore(), tmp_path / "cache")`.
    Every Plan 1–2 archive test must pass on both.
  - **Remote-only tests:**
    - `test_remote_cold_cache_sees_other_writer`: archive A writes a blob, a
      record, a wellness record and an export. Archive B (same store, empty
      cache) then:
      - `get_blob`s it;
      - `list_records()` equals A's;
      - `list_wellness()` equals A's;
      - `put_export` of the same file returns A's key.
    - `test_remote_put_record_dedupes_against_store_not_cache`: B `put_record`s
      the same content A already stored → `False`, and no new key appears in
      `store.list("records/")`.
    - `test_remote_failed_upload_leaves_cache_clean`:
      - wrap `MemoryStore.put` so the second call raises `OSError`;
      - `put_blob(b"1")` succeeds and `put_blob(b"2")` raises;
      - the cache folder holds only `raw/<sha of b"1">`;
      - a fresh `RemoteArchive` with a working store re-uploads `b"2"` on
        `put_blob`.
    - `test_remote_export_same_size_compares_sha_metadata`: two different
      files with equal size → two keys. The same file twice → one key, and
      `head` metadata `sha256` equals the file's sha.
    - `test_open_archive_selection`, with env cleared by the conftest fixture:
      - no settings → `LocalArchive` at `data/archive`;
      - `R2_*` set → `RemoteArchive`;
      - `--archive file:///x` with `R2_*` set → `LocalArchive("/x")`;
      - `r2://other` with `R2_BUCKET=mine` → `ValueError`.
  - **`conftest.py`:** an autouse fixture that deletes every `R2_*` and
    `ARCHIVE_URL` env var and points `config.DOTENV_FILE` at a nonexistent
    path. That is Review Focus 5.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_archive.py -q`.
  Expected: the remote params FAIL (`RemoteArchive` not defined).

- [ ] **Step 3: Implement `RemoteArchive(LocalArchive)`** with `root=cache_root`:
  - **`_write(key, write)`:** render the bytes in memory, then
    `store.put(key, data)`, then `super()._write`. Store first, so the cache
    is always a subset of R2.
  - **`has_blob`:** cache, else `store.head`.
  - **`get_blob`:** cache, else `store.get` (absent → `KeyError`), then
    write the cache only.
  - **`_sync(prefix)`:** `store.list(prefix)`, download each key missing from
    the cache into the cache. Keys under `records/` and `wellness/` are
    immutable (timestamp + content hash), so presence is enough.
    - `list_records` syncs `records/`.
    - `list_wellness` syncs `wellness/`.
    - `put_record` / `put_wellness` sync their own directory before comparing.
  - **`put_export`:** never cached.
    - Same-export check: `store.list(f"exports/{provider}/")`; for entries of
      equal size, compare `head(key)["metadata"].get("sha256")` with the
      file's sha.
    - Upload with `store.put_file(key, path, metadata={"sha256": sha})`.
  - **`.gitignore`:** add `data/cache/`.

- [ ] **Step 4: Run the whole Python suite.**
  Run: `.venv/bin/python -m pytest ingest -q`. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: archive to R2 through a local cache"`

---

### Task 3: Writer cycle and snapshots

**Files:**
- Create: `ingest/writer.py`, `ingest/tests/test_writer.py`

**Interfaces:**
- Consumes: `RemoteArchive.store`, `is_remote`, `PreconditionFailed`.
- Produces:
  - `writer.DB_KEY = "db/activities.sqlite"`, `writer.SNAPSHOT_PREFIX = "db/snapshots/"`,
    `writer.WRITE_ATTEMPTS = 3`, `writer.SNAPSHOT_DAYS = 30`.
  - `writer.run(db_path: str, archive: Archive, work: Callable[[str], T], *, today: str, init_db: bool = False) -> T`.
  - `writer.pull(store, dest: str) -> str | None`: writes the remote database
    to `dest` and returns its etag, or `None` when R2 has none.
  - `writer.snapshots_to_delete(dates: list[str]) -> list[str]`: dates are
    `YYYY-MM-DD`. Returns the ones outside "the 30 newest plus the oldest of
    each month".

- [ ] **Step 1: Write the failing tests** in `test_writer.py`. Use
  `MemoryStore`, a `RemoteArchive` over it, and a `work` that opens the db with
  `db.open_db` and inserts a gear row named after the attempt.
  - `test_local_archive_runs_in_place`: with a `LocalArchive`, `work` receives
    `db_path` itself and nothing is uploaded.
  - `test_missing_remote_db_exits_6`: with an empty store and
    `init_db=False`:
    - `SystemExit` with code 6;
    - `work` never ran;
    - `store.list("db/") == []`.
  - `test_init_db_creates_with_if_none_match`:
    - `init_db=True` uploads `db/activities.sqlite` and
      `db/snapshots/<today>.sqlite`;
    - the local `db_path` equals the uploaded bytes.
  - `test_conflict_repulls_and_redoes`:
    - on its first call, `work` also puts a different database to `DB_KEY`
      directly in the store (the other writer);
    - `run` calls `work` twice;
    - the final R2 database holds the other writer's row and attempt 2's row;
    - the result is attempt 2's return value.
  - `test_three_conflicts_exit_5`: `work` always races → `SystemExit(5)`
    after exactly 3 calls. The store keeps the racer's last database.
  - `test_unchanged_db_is_not_uploaded`:
    - a `work` that changes nothing → no new etag on `DB_KEY` and no
      snapshot;
    - with `GITHUB_OUTPUT` pointed at a temp file, it contains
      `db_changed=false`;
    - a changing `work` writes `db_changed=true`.
  - `test_work_failure_uploads_nothing`: `work` raises `RuntimeError` → it
    propagates, the R2 etag is unchanged, and `db_path` is unchanged.
  - `test_snapshots_to_delete`:
    - dates are every day from 2026-01-01 to 2026-04-30;
    - the result keeps the 30 newest, plus `2026-01-01`, `2026-02-01` and
      `2026-03-01`;
    - `2026-04-01` is already among the 30 newest;
    - every other date is deleted;
    - an empty list → `[]`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_writer.py -q`.
  Expected: FAIL (`ingest.writer` not found).

- [ ] **Step 3: Implement `run`.** With a remote archive, each attempt:
  1. `etag = pull(store, tmp)` into `db_path + ".pull"`.
     - `None` and not `init_db` → print
       `"R2 has no database at db/activities.sqlite: run an import with --init-db first (see migration)"`
       to stderr and `SystemExit(6)`.
     - `None` with `init_db` → start from a missing file; `work` initializes
       it.
  2. `before = sha256(tmp)` (or `None`), then `result = work(tmp)`.
  3. Unchanged → `os.replace(tmp, db_path)`, `changed = False`, done.
  4. Otherwise:
     - `store.put(DB_KEY, bytes, if_match=etag)`, or
       `if_none_match="*"` when `etag is None`;
     - on `PreconditionFailed`: warn `"R2 database changed during the run (attempt n/3); redoing"`
       and go to the next attempt;
     - on success: put `f"{SNAPSHOT_PREFIX}{today}.sqlite"`, delete
       `snapshots_to_delete(...)`, `os.replace(tmp, db_path)`, set
       `changed = True`.
  5. After the loop:
     - append `db_changed=true|false` to `$GITHUB_OUTPUT` if set;
     - remove a leftover tmp on every exit path;
     - 3 failed attempts → stderr message and `SystemExit(5)`.

- [ ] **Step 4: Run the whole Python suite.**
  Run: `.venv/bin/python -m pytest ingest -q`. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: pull, write and upload the database with If-Match"`

---

### Task 4: Every writer through the cycle, plus `sync`

**Files:**
- Modify: `ingest/strava_import.py`, `ingest/garmin_import.py`, `ingest/garmin_fetch.py`, `ingest/rebuild.py`, `ingest/activity_cli.py` (each `main()`), `package.json`, `README.md`
- Create: `ingest/sync.py`, `ingest/tests/test_sync.py`
- Test: `ingest/tests/test_fetch_and_import.py`, `ingest/tests/test_activity_cli.py`

**Interfaces:**
- Consumes: `writer.run`, `writer.pull`, `open_archive`, `is_remote`.
- Produces:
  - CLI flags:
    - `--init-db` on `import:strava` and `import:garmin` only;
    - `--archive` on `activity` (it has none today).
  - `sync.main()`, run as `pnpm sync` → `${PYTHON_BIN:-python3} -m ingest.sync`.
    It writes the R2 database to `--db` (default `data/activities.sqlite`).
    With a local archive it exits 1 with
    `"sync: no R2 configured (set R2_* in .env); the local database is already the master"`.

- [ ] **Step 1: Write the failing tests.**
  - **`test_fetch_and_import.py`:**
    - `test_import_then_fetch_through_r2`. Monkeypatch
      `archive.store_from_env` to return one shared `MemoryStore`, and set
      `R2_BUCKET`.
      1. `strava_import.main` with `--init-db` on a fixture export;
      2. `garmin_fetch.main` with a fake client (reuse the existing fake);
      3. delete the local `db_path` and `data/cache`;
      4. `sync.main()`.
      Assert: the synced database holds both runs' activities with unchanged
      IDs.
    - `test_fetch_without_remote_db_exits_6`.
  - **`test_activity_cli.py`:** `test_hide_through_r2` → after `activity hide`
    with the R2 env, the R2 database has the override row.
  - **`test_sync.py`:** `test_sync_without_r2_exits_1` and
    `test_sync_overwrites_local_copy`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_fetch_and_import.py ingest/tests/test_activity_cli.py ingest/tests/test_sync.py -q`.
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Each `main()`:** build the archive once, then
    `writer.run(args.db, archive, lambda path: <existing work with db_path=path>, today=date.today().isoformat(), init_db=getattr(args, "init_db", False))`.
    - `GarminFetcher` is constructed inside the lambda, so a redo starts
      clean. `authenticate()` stays before `writer.run` (fail loud on a bad
      key before any pull).
    - `rebuild` keeps its orphan check: it runs inside `work` against the
      pulled copy.
  - **`package.json`:** add `"sync"`.
  - **README:**
    - add a section **R2 (optional, the owner's setup)** after Config. It
      covers:
      - the four `.env` names;
      - that with them set, every command reads and writes R2 and keeps
        `data/activities.sqlite` as a synced copy;
      - `pnpm sync`;
      - exit codes 5 and 6;
      - `--init-db` for the first import;
    - in Populating the database, note that the first import into an empty
      R2 needs `--init-db`.

- [ ] **Step 4: Run the whole Python suite.**
  Run: `.venv/bin/python -m pytest ingest -q`. Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: run every writer through the R2 cycle and add sync"`

---

### Task 5: Display bridge (visible activities, source links)

Until Plan 4, the v1 display pipeline reads the v2 database. Plan 4 replaces
it.

**Files:**
- Modify: `scripts/build-tracks.ts`, `scripts/types.ts`, `app/src/types.ts`, `app/src/tracks.ts`, `app/src/format.ts`, `app/src/App.tsx`, `app/src/ui/InfoPanel.tsx`, `app/src/ui/StatsSection.tsx`
- Test: `scripts/build-tracks.test.ts`, `app/src/format.test.ts`, `app/src/tracks.test.ts`

**Interfaces:**
- Produces:
  - Wire format `v: 3`. `PAYLOAD_VERSION = 3` in both `scripts/build-tracks.ts`
    and `app/src/tracks.ts`.
  - `EncodedTrack.sources: { provider: "strava" | "garmin"; id: string }[]`:
    live sources only, Strava first.
  - `ActivityFeatureProps.id` doc: "random activity id (v2), opaque".
  - `activityLinks(sources: ActivitySource[]) -> { url: string; label: string }[]`
    replaces `activityLink(id)`. Same URLs and labels as today, in source
    order. An unknown provider is skipped.
  - `StatsSection` / `InfoPanel` prop `links: {url, label}[]` (was
    `link | null`). Each renders as today's single link did.

- [ ] **Step 1: Write the failing tests.**
  - **`scripts/build-tracks.test.ts`:** build an in-memory v2 database with
    `better-sqlite3`, using the `activities` and `activity_sources` columns
    from `ingest/db.py`.
    - `test drops invisible activities`: a `visible = 0` activity with a
      polyline is absent.
    - `test sources lists live providers strava first`:
      - an activity with a Garmin source and a Strava source →
        `sources == [{provider:"strava",id:"111"},{provider:"garmin",id:"222"}]`;
      - after setting the Garmin source's `deleted_at` → only the Strava
        entry. That is Review Focus 3.
    - `test missing database writes an empty payload`: a `DB_PATH` that
      doesn't exist → `{v: 3, tracks: []}` and a warning naming `pnpm sync`.
      The query-and-encode part is exported as a function taking the database
      path, so the test doesn't run `main`.
  - **`format.test.ts`:** replace the `activityLink` tests with
    `activityLinks`:
    - strava + garmin → two links in order;
    - `[]` → `[]`;
    - unknown provider → skipped.
  - **`tracks.test.ts`:** payload `v: 2` now throws; fixtures move to `v: 3`
    with `sources`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm run test && pnpm --filter app run test`. Expected: the new tests
  FAIL.

- [ ] **Step 3: Implement.**
  - **Query:** `... FROM activities WHERE visible = 1 AND polyline <> '' ORDER BY start_time`.
  - **Sources:** one query over `activity_sources WHERE deleted_at IS NULL`,
    grouped by `activity_id`.
  - **Nulls:** v2 numbers can be NULL where v1 stored 0. The bridge writes
    `?? 0` for `distance`, `moving_time` and `elevation_gain`, which is v1's
    display behaviour. Comment: `// v1 display behaviour; Plan 4's display files keep NULL absent`.
  - **App:** `App.tsx` passes `activityLinks(p.sources)`; totals pass `[]`.

- [ ] **Step 4: Run all checks.**
  Run: `pnpm run typecheck && pnpm run test && pnpm --filter app run test`.
  Expected: all pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: publish only visible activities with a link per source"`

---

### Task 6: Workflows

**Files:**
- Modify: `.github/workflows/fetch-garmin.yml`, `.github/workflows/deploy.yml`, `scripts/ci_fetch.sh`, `.gitignore`, `README.md` (CI, Setting up your own copy)
- Create: `scripts/ci_db.sh`
- Test: `ingest/tests/test_ci_fetch.py` (rewritten), `ingest/tests/test_ci_db.py`

**Interfaces:**
- Consumes: `garmin_fetch` through the writer (writes `db_changed` to
  `$GITHUB_OUTPUT`).
- Produces:
  - **`scripts/ci_fetch.sh`:**
    - without `R2_BUCKET`: prints
      `::notice::no R2 secrets: the daily fetch needs R2` and exits 0;
    - otherwise runs `${PYTHON_BIN:-python3} -m ingest.garmin_fetch --db "$DB"`;
    - no git commands.
  - **`scripts/ci_db.sh`:** prints the database path for the build to stdout.
    Only that path; logs go to stderr.
    - With `R2_RO_ACCESS_KEY_ID`:
      `aws s3 cp "s3://$R2_BUCKET/db/activities.sqlite" data/activities.sqlite --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"`.
      Env: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from the RO pair,
      `AWS_DEFAULT_REGION=auto`,
      `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`,
      `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`.
      A failed copy fails the script (`set -euo pipefail`).
    - Else, if `data/demo/activities.sqlite` exists: prints that path.
    - Else: prints `data/activities.sqlite`, plus a `::warning::` that the
      site will be empty. `build-tracks` then writes an empty payload.

- [ ] **Step 1: Write the failing tests.** Run the scripts with `subprocess`
  and a stub `aws` / `python` on `PATH`, like today's `test_ci_fetch.py`.
  - **`test_ci_fetch.py`:**
    - `test_skips_without_r2`: exit 0, the notice is printed, and `python` is
      never called;
    - `test_runs_fetch_with_r2`: the stub python is called with
      `-m ingest.garmin_fetch --db data/activities.sqlite`;
    - `test_never_touches_git`: a stub `git` on `PATH` that fails the test if
      called.
  - **`test_ci_db.py`:**
    - `test_pulls_with_read_only_pair`: the stub `aws` records argv and env.
      The endpoint and both checksum env vars are as above, the key id is the
      RO one, and stdout is `data/activities.sqlite`.
    - `test_failed_pull_fails`: the stub `aws` exits 1 → the script exits
      non-zero and prints no path. That is Review Focus: the owner's site is
      never published empty because of a failed pull.
    - `test_demo_fallback`: with no secrets and `data/demo/activities.sqlite`
      present → that path.
    - `test_empty_fallback_warns`: with neither → the warning, and stdout
      `data/activities.sqlite`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `.venv/bin/python -m pytest ingest/tests/test_ci_fetch.py ingest/tests/test_ci_db.py -q`.
  Expected: FAIL.

- [ ] **Step 3: Implement the scripts, then the workflows.**
  - **`fetch-garmin.yml`:**
    - `permissions: contents: read`;
    - checkout without `GH_PAT`;
    - env: `GARMIN_PERSONAL_API_KEY` + the four `R2_*` secrets;
    - fetch step `id: fetch`, running `scripts/ci_fetch.sh`;
    - job output `db_changed: ${{ steps.fetch.outputs.db_changed }}`;
    - a second job `deploy`:
      - `needs: fetch`;
      - `if: needs.fetch.outputs.db_changed == 'true'`;
      - `uses: ./.github/workflows/deploy.yml`;
      - `secrets: inherit`;
      - `permissions: { contents: read, pages: write, id-token: write }`;
    - keep `concurrency: fetch-garmin`.
  - **`deploy.yml`:**
    - add `workflow_call:`;
    - path filter `["app/**", "scripts/**", ".github/workflows/deploy.yml"]`;
    - before the build, a step `id: db` that runs
      `echo "path=$(scripts/ci_db.sh)" >> "$GITHUB_OUTPUT"` with the RO
      secrets, `R2_ACCOUNT_ID` and `R2_BUCKET` in env;
    - the build step gets `DB_PATH: ${{ steps.db.outputs.path }}`.
  - **`.gitignore`:** replace the `data/raw/`, `data/archive/` and
    `data/cache/` lines with `data/*` and `!data/demo/`. Do **not** remove
    `data/activities.sqlite` from git here; Task 7 does it at cutover.
  - **README:**
    - CI section: the secrets become `GARMIN_PERSONAL_API_KEY`, the four
      `R2_*`, and the RO pair. `GH_PAT` is no longer used: delete it.
    - Setting up your own copy: say that without R2 secrets the site deploys
      the demo data, or an empty map until §6 adds it, and the daily fetch is
      skipped.

- [ ] **Step 4: Run all checks.**
  Run: `.venv/bin/python -m pytest ingest -q && pnpm run test && pnpm --filter app run test`.
  Also run `actionlint` on both workflows if it is installed. Expected: all
  pass.

- [ ] **Step 5: Commit.** `git commit -m "feat: fetch into R2 and deploy from it, with a fork fallback"`

---

### Task 7: Migration and cutover (owner + agent, mostly no code)

The spec's "Migration from v1", plus the measurements Plans 1 and 2 left open.
The owner does the account steps. The agent runs the rest on the laptop with
the owner's `.env`.

- [ ] **Step 1 (owner): R2.**
  - Create a private bucket.
  - Create an **Object Read & Write** token scoped to that bucket, and an
    **Object Read** token scoped to it.
  - Put the RW values in `.env` as `R2_*`.
  - `gh secret set` the RW four plus `R2_RO_ACCESS_KEY_ID` /
    `R2_RO_SECRET_ACCESS_KEY`.

- [ ] **Step 2: Live store check.**
  `R2_LIVE_TEST=1 .venv/bin/python -m pytest ingest/tests/test_objstore_live.py -v`
  → PASS. A failure here (most likely the checksum config or `If-Match`
  support) stops the migration.

- [ ] **Step 3 (owner): Fresh exports.**
  - Request the Strava bulk export and the Garmin GDPR export.
  - Save both zips outside the repo.

- [ ] **Step 4: Import.**
  1. `pnpm import:strava <zip> --init-db`.
  2. `pnpm import:garmin <zip>`.
  3. `pnpm fetch:garmin --wellness-since 2025-04-19`. Garmin data starts
     2025-04-19, and intraday series are kept only about 4 months, so don't
     delay this step.

- [ ] **Step 5: Measure and sanity-check.** Report in the PR description.
  - **v1 comparison:** `git show main:data/activities.sqlite > /tmp/v1.sqlite`.
    - Activity counts per provider against v1 (490 Strava, 390+ Garmin);
    - merged pairs against v1's **352**, with every difference explained.
  - **Sizes:**
    - the R2 database;
    - `raw/` and `exports/` totals (`store.list`);
    - the sum of `streams` blob bytes;
    - against the design's estimates and the 10 GB free tier.
  - **Coverage:** counts of `has_gps`, `has_hr`, `has_altitude`,
    `has_cadence`, `has_power`.
  - **Absent-header warnings** from both importers.
  - **Unverified Garmin names** (Plan 1 Tasks 8–9).
  - **Garmin gear:** where gear appears in the export.
  - **Export zips:** member dates in both zips (`export_made_at`).
  - **Monitoring FITs:** count and date range, other file types, and whether
    `monitoring_a` / `monitoring_daily` parse.
  - Any finding that needs a code change becomes a fix commit on the branch
    before Step 6.

- [ ] **Step 6: Cut over.**
  1. Rebase onto `main`. Resolve the `data/activities.sqlite` modify/delete
     conflict by deleting it.
  2. `git rm --cached data/activities.sqlite`.
  3. Commit `chore: drop the committed database; R2 is the master`.
  4. Run the full checks (Task 6 Step 4).
  5. Open the PR; the owner reviews and merges.

- [ ] **Step 7: First CI run.**
  1. `gh workflow run fetch-garmin.yml`.
  2. Confirm the fetch job uploads (`db_changed=true` on a day with new data)
     or reports no change.
  3. Confirm the deploy pulls from R2 and the site shows the activities with
     both links on merged ones.
  4. The owner deletes the `GH_PAT` secret.

## Out of scope

- Display files with streams, per-activity detail files, and NULL-aware stats
  (Plan 4).
- The synthetic demo dataset and git history cleanup (§6).
- An offline mirror of the whole archive on the laptop. `get_blob` fetches on
  demand, which is what the MCP server and rebuilds need.
- Strava live fetch (spec non-goal).
