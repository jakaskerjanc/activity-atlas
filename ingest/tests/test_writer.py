import hashlib
import os
import warnings
from datetime import date, timedelta

import pytest
from ingest import db, engine, writer
from ingest.archive import LocalArchive, RemoteArchive
from ingest.objstore import MemoryStore
from ingest.tests.test_grouping import A, N, _hike
from ingest.tests.track_fixture import climb_alts, insert_activity

TODAY = "2026-05-01"


def make_db_bytes(tmp_path, name, gear=()):
    path = str(tmp_path / f"{name}.sqlite")
    conn = db.open_db(path)
    for g in gear:
        conn.execute("INSERT INTO gear (provider, name) VALUES ('strava', ?)", (g,))
    conn.commit()
    conn.close()
    with open(path, "rb") as fh:
        return fh.read()


def gear_names(data: bytes, tmp_path) -> list[str]:
    path = str(tmp_path / "inspect.sqlite")
    with open(path, "wb") as fh:
        fh.write(data)
    conn = db.open_db(path)
    names = [r[0] for r in conn.execute("SELECT name FROM gear ORDER BY name")]
    conn.close()
    return names


class Work:
    """A `work` that records its calls and inserts a gear row named after the attempt."""

    def __init__(self, store=None, tmp_path=None, race=lambda attempt: False):
        self.calls = 0
        self.store = store
        self.tmp_path = tmp_path
        self.race = race

    def __call__(self, path):
        self.calls += 1
        conn = db.open_db(path)
        conn.execute("INSERT INTO gear (provider, name) VALUES ('strava', ?)", (f"attempt-{self.calls}",))
        conn.commit()
        conn.close()
        if self.race(self.calls):
            other = make_db_bytes(self.tmp_path, f"other-{self.calls}", gear=[f"other-{self.calls}"])
            self.store.put(writer.DB_KEY, other)
        return f"result-{self.calls}"


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def archive(store, tmp_path):
    return RemoteArchive(store, str(tmp_path / "cache"))


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "data" / "activities.sqlite")


@pytest.fixture(autouse=True)
def _no_github_output(monkeypatch):
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)


def seed(store, tmp_path, *gear):
    return store.put(writer.DB_KEY, make_db_bytes(tmp_path, "seed", gear=gear))


def test_local_archive_runs_in_place(tmp_path, db_path):
    seen = []

    def work(path):
        seen.append(path)
        return "done"

    assert writer.run(db_path, LocalArchive(str(tmp_path / "a")), work, today=TODAY) == "done"
    assert seen == [db_path]


def test_missing_remote_db_exits_6(store, archive, db_path):
    work = Work()
    with pytest.raises(SystemExit) as exc:
        writer.run(db_path, archive, work, today=TODAY)
    assert exc.value.code == 6
    assert work.calls == 0
    assert store.list("db/") == []
    assert not os.path.exists(db_path)


def test_init_db_creates_with_if_none_match(store, archive, db_path):
    work = Work()
    assert writer.run(db_path, archive, work, today=TODAY, init_db=True) == "result-1"
    uploaded, _ = store.get(writer.DB_KEY)
    assert [k for k, _ in store.list("db/")] == [writer.DB_KEY, f"db/snapshots/{TODAY}.sqlite"]
    assert store.get(f"db/snapshots/{TODAY}.sqlite")[0] == uploaded
    with open(db_path, "rb") as fh:
        assert fh.read() == uploaded
    assert not os.path.exists(db_path + ".pull")


def test_init_db_does_not_overwrite_a_database_created_meanwhile(store, archive, db_path, tmp_path):
    work = Work(store, tmp_path, race=lambda n: n == 1)
    assert writer.run(db_path, archive, work, today=TODAY, init_db=True) == "result-2"
    # attempt 2 pulled the racer's database and added its own row
    assert gear_names(store.get(writer.DB_KEY)[0], tmp_path) == ["attempt-2", "other-1"]


def test_pulls_existing_db_and_uploads_the_change(store, archive, db_path, tmp_path):
    seed(store, tmp_path, "old")
    assert writer.run(db_path, archive, Work(), today=TODAY) == "result-1"
    assert gear_names(store.get(writer.DB_KEY)[0], tmp_path) == ["attempt-1", "old"]
    assert gear_names(store.get(f"db/snapshots/{TODAY}.sqlite")[0], tmp_path) == ["attempt-1", "old"]
    assert gear_names(open(db_path, "rb").read(), tmp_path) == ["attempt-1", "old"]


def test_conflict_repulls_and_redoes(store, archive, db_path, tmp_path):
    seed(store, tmp_path, "old")
    work = Work(store, tmp_path, race=lambda n: n == 1)
    assert writer.run(db_path, archive, work, today=TODAY) == "result-2"
    assert work.calls == 2
    assert gear_names(store.get(writer.DB_KEY)[0], tmp_path) == ["attempt-2", "other-1"]
    assert gear_names(open(db_path, "rb").read(), tmp_path) == ["attempt-2", "other-1"]


def test_three_conflicts_exit_5(store, archive, db_path, tmp_path, capsys):
    seed(store, tmp_path, "old")
    work = Work(store, tmp_path, race=lambda n: True)
    with pytest.raises(SystemExit) as exc:
        writer.run(db_path, archive, work, today=TODAY)
    assert exc.value.code == 5
    assert work.calls == writer.WRITE_ATTEMPTS == 3
    assert gear_names(store.get(writer.DB_KEY)[0], tmp_path) == ["other-3"]
    assert [k for k, _ in store.list("db/")] == [writer.DB_KEY]
    assert not os.path.exists(db_path)
    assert not os.path.exists(db_path + ".pull")
    assert "redoing" in capsys.readouterr().err


def test_unchanged_db_is_not_uploaded(store, archive, db_path, tmp_path, monkeypatch):
    etag = seed(store, tmp_path, "old")
    out = tmp_path / "github_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))

    assert writer.run(db_path, archive, lambda path: db.open_db(path).close(), today=TODAY) is None
    assert store.head(writer.DB_KEY)["etag"] == etag
    assert [k for k, _ in store.list("db/")] == [writer.DB_KEY]
    assert out.read_text() == "db_changed=false\n"
    assert os.path.exists(db_path)
    assert not os.path.exists(db_path + ".pull")

    writer.run(db_path, archive, Work(), today=TODAY)
    assert store.head(writer.DB_KEY)["etag"] != etag
    assert out.read_text() == "db_changed=false\ndb_changed=true\n"


def test_work_failure_uploads_nothing(store, archive, db_path, tmp_path):
    etag = seed(store, tmp_path, "old")
    os.makedirs(os.path.dirname(db_path))
    with open(db_path, "wb") as fh:
        fh.write(b"previous local db")

    def work(path):
        Work()(path)
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        writer.run(db_path, archive, work, today=TODAY)
    assert store.head(writer.DB_KEY)["etag"] == etag
    assert [k for k, _ in store.list("db/")] == [writer.DB_KEY]
    with open(db_path, "rb") as fh:
        assert fh.read() == b"previous local db"
    assert not os.path.exists(db_path + ".pull")


def test_old_snapshots_are_pruned_on_upload(store, archive, db_path, tmp_path):
    seed(store, tmp_path)
    for i in range(40):
        d = (date(2026, 3, 20) + timedelta(days=i)).isoformat()
        store.put(f"db/snapshots/{d}.sqlite", b"x")
    store.put("db/snapshots/notes.txt", b"keep me")
    writer.run(db_path, archive, Work(), today=TODAY)
    names = [k for k, _ in store.list("db/snapshots/")]
    assert f"db/snapshots/{TODAY}.sqlite" in names
    assert "db/snapshots/2026-03-20.sqlite" in names  # first of its month in the list
    assert "db/snapshots/2026-03-21.sqlite" not in names
    assert "db/snapshots/notes.txt" in names


def test_snapshots_to_delete():
    days = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range((date(2026, 4, 30) - date(2026, 1, 1)).days + 1)]
    deleted = set(writer.snapshots_to_delete(days))
    kept = set(days) - deleted
    assert kept == set(days[-30:]) | {"2026-01-01", "2026-02-01", "2026-03-01"}
    assert "2026-04-01" in kept
    assert writer.snapshots_to_delete([]) == []


def test_nested_local_writer_does_not_clobber_working_copy(store, archive, db_path, tmp_path):
    seed(store, tmp_path, "base")

    def add_gear(path, name):
        conn = db.open_db(path)
        conn.execute("INSERT INTO gear (provider, name) VALUES ('strava', ?)", (name,))
        conn.commit()
        conn.close()

    calls = []

    def work_a(path):
        calls.append(path)
        if len(calls) == 1:
            # writer B: a complete run on the same db_path and store
            writer.run(db_path, archive, lambda p: add_gear(p, "from-b"), today=TODAY)
        add_gear(path, f"from-a-{len(calls)}")

    writer.run(db_path, archive, work_a, today=TODAY)

    assert len(calls) == 2  # the first upload hit a 412 and A redid
    data, _ = store.get(writer.DB_KEY)
    assert gear_names(data, tmp_path) == ["base", "from-a-2", "from-b"]
    assert len(set(calls)) == 2  # every attempt got its own working copy
    assert not [n for n in os.listdir(os.path.dirname(db_path)) if ".pull-" in n]


def test_stale_journal_is_not_rolled_into_the_pulled_database(store, archive, db_path, tmp_path):
    seed(store, tmp_path, "base")
    os.makedirs(os.path.dirname(db_path))
    for suffix in ("-journal", "-wal", "-shm"):
        with open(db_path + suffix, "wb") as fh:
            fh.write(b"stale")
    writer.run(db_path, archive, Work(), today=TODAY)
    assert not [s for s in ("-journal", "-wal", "-shm") if os.path.exists(db_path + s)]


# --- the refresh after every write -----------------------------------------------------------------------------

def _insert_hike(path, id_="hike1"):
    conn = db.open_db(path)
    insert_activity(conn, id_, "Hike", "2025-06-01T07:00:00+00:00", _hike(A, 0), alts=climb_alts(N, 300))
    conn.commit()
    conn.close()
    return "inserted"


def _read(data: bytes, tmp_path, sql: str) -> list[tuple]:
    path = str(tmp_path / "inspect.sqlite")
    with open(path, "wb") as fh:
        fh.write(data)
    conn = db.connect(path)
    try:
        return [tuple(r) for r in conn.execute(sql)]
    finally:
        conn.close()


def _boom(path, log=print):
    raise RuntimeError("refresh boom")


REFRESH_FAILED = "places and routes were not refreshed"


def test_unchanged_run_still_uploads_nothing(store, archive, db_path, tmp_path):
    etag = seed(store, tmp_path, "old")
    assert writer.run(db_path, archive, lambda path: db.open_db(path).close(), today=TODAY) is None
    assert store.head(writer.DB_KEY)["etag"] == etag
    assert [k for k, _ in store.list("db/")] == [writer.DB_KEY]

    assert writer.run(db_path, archive, _insert_hike, today=TODAY) == "inserted"
    uploaded = store.get(writer.DB_KEY)[0]
    assert _read(uploaded, tmp_path, "SELECT * FROM activity_groups") == [("hike1", "hike1", None)]
    assert _read(uploaded, tmp_path, "SELECT id FROM places") == [("hike1",)]


def test_refresh_failure_still_uploads_and_exits_7(store, archive, db_path, tmp_path, monkeypatch, capsys):
    seed(store, tmp_path, "old")
    monkeypatch.setattr("ingest.refresh.refresh_file", _boom)
    out = tmp_path / "github_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    with pytest.raises(SystemExit) as exc:
        writer.run(db_path, archive, _insert_hike, today=TODAY)
    assert exc.value.code == writer.EXIT_REFRESH_FAILED == 7
    for key in (writer.DB_KEY, f"db/snapshots/{TODAY}.sqlite"):
        data = store.get(key)[0]
        assert _read(data, tmp_path, "SELECT id FROM activities") == [("hike1",)]
        assert _read(data, tmp_path, "SELECT * FROM activity_groups") == []
    assert out.read_text() == "db_changed=true\n"
    err = capsys.readouterr().err
    assert "Traceback" in err and "refresh boom" in err and REFRESH_FAILED in err
    assert err.index("refresh boom") < err.index(REFRESH_FAILED)


def test_refresh_failure_after_a_lost_race_still_uploads_and_exits_7(store, archive, db_path, tmp_path,
                                                                      monkeypatch, capsys):
    seed(store, tmp_path, "old")
    monkeypatch.setattr("ingest.refresh.refresh_file", _boom)
    work = Work(store, tmp_path, race=lambda n: n == 1)
    with pytest.raises(SystemExit) as exc:
        writer.run(db_path, archive, work, today=TODAY)
    assert exc.value.code == 7 and work.calls == 2
    assert gear_names(store.get(writer.DB_KEY)[0], tmp_path) == ["attempt-2", "other-1"]
    assert "redoing" in capsys.readouterr().err


def test_refresh_failure_with_nothing_to_upload_exits_7(store, archive, db_path, tmp_path, monkeypatch):
    etag = seed(store, tmp_path, "old")
    monkeypatch.setattr("ingest.refresh.refresh_file", _boom)
    with pytest.raises(SystemExit) as exc:
        writer.run(db_path, archive, lambda path: None, today=TODAY)
    assert exc.value.code == 7
    assert store.head(writer.DB_KEY)["etag"] == etag
    assert os.path.exists(db_path)


def test_refresh_failure_local_keeps_work_and_exits_7(tmp_path, db_path, monkeypatch, capsys):
    monkeypatch.setattr("ingest.refresh.refresh_file", _boom)
    with pytest.raises(SystemExit) as exc:
        writer.run(db_path, LocalArchive(str(tmp_path / "a")), _insert_hike, today=TODAY)
    assert exc.value.code == 7
    with open(db_path, "rb") as fh:
        assert _read(fh.read(), tmp_path, "SELECT id FROM activities") == [("hike1",)]
    err = capsys.readouterr().err
    assert "refresh boom" in err and REFRESH_FAILED in err


def test_local_run_refreshes(tmp_path, db_path):
    os.makedirs(os.path.dirname(db_path))
    assert writer.run(db_path, LocalArchive(str(tmp_path / "a")), _insert_hike, today=TODAY) == "inserted"
    with open(db_path, "rb") as fh:
        assert _read(fh.read(), tmp_path, "SELECT * FROM activity_groups") == [("hike1", "hike1", None)]


def test_first_write_job_on_a_v4_remote_database(store, archive, db_path, tmp_path):
    """The first daily job after the upgrade: R2 holds a v4 database and the archive the records behind it,
    among them a walk that climbs 106 m. The job opens the database as the fetchers do, which rebuilds it
    to v5; the run's refresh then fills the group tables, and the upload carries both."""
    from ingest.tests.test_rebuild import NOW, _imported
    (tmp_path / "import").mkdir()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        dbp, local = _imported(tmp_path / "import")
    for root, _, files in os.walk(local.root):          # the archive, under the same keys in R2
        for name in files:
            path = os.path.join(root, name)
            with open(path, "rb") as fh:
                store.put(os.path.relpath(path, local.root).replace(os.sep, "/"), fh.read())
    conn = db.connect(dbp)
    [walk] = [r[0] for r in conn.execute("SELECT id FROM activities WHERE type = 'Walk'")]
    for table in ("activity_groups", "route_groups", "places", "group_overrides", "osm_points"):
        conn.execute(f"DROP TABLE {table}")
    conn.execute("PRAGMA user_version = 4")
    conn.commit()
    conn.close()
    with open(dbp, "rb") as fh:
        store.put(writer.DB_KEY, fh.read())

    def work(path):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            engine.open_for_write(path, archive, now=NOW).close()
        return "fetched"

    assert writer.run(db_path, archive, work, today=TODAY) == "fetched"
    for key in (writer.DB_KEY, f"db/snapshots/{TODAY}.sqlite"):
        data = store.get(key)[0]
        assert _read(data, tmp_path, "PRAGMA user_version") == [(db.SCHEMA_VERSION,)] == [(5,)]
        assert _read(data, tmp_path, "SELECT id, name, name_source, kind FROM places") == [
            (walk, "Top at 410 m", "fallback", "top")]
        assert _read(data, tmp_path, "SELECT * FROM activity_groups") == [(walk, walk, None)]
        assert len(_read(data, tmp_path, "SELECT id FROM activities")) == 3
