import hashlib
import os
from datetime import date, timedelta

import pytest
from ingest import db, writer
from ingest.archive import LocalArchive, RemoteArchive
from ingest.objstore import MemoryStore

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
