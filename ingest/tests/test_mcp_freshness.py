import hashlib
import sqlite3

import pytest

from ingest import writer
from ingest.mcp_server.database import Database
from ingest.mcp_server.freshness import Syncer, as_of
from ingest.objstore import MemoryStore
from ingest.tests.mcp_fixture import build_fixture_db


def md5(path):
    with open(path, "rb") as fh:
        return hashlib.md5(fh.read()).hexdigest()


class SpyStore(MemoryStore):
    def __init__(self):
        super().__init__()
        self.get_calls = 0
        self.head_calls = 0

    def get(self, key):
        self.get_calls += 1
        return super().get(key)

    def head(self, key):
        self.head_calls += 1
        return super().head(key)


class FailingStore(MemoryStore):
    def head(self, key):
        raise ConnectionError("network down")


@pytest.fixture
def path(tmp_path):
    return build_fixture_db(str(tmp_path / "data" / "activities.sqlite"))


def _with_extra_activity(tmp_path, path) -> bytes:
    other = str(tmp_path / "other.sqlite")
    with open(path, "rb") as src, open(other, "wb") as dst:
        dst.write(src.read())
    c = sqlite3.connect(other)
    c.execute("INSERT INTO activities (id, type, start_time, start_local, visible) "
              "VALUES ('extra', 'Run', '2026-11-04T07:00:00+00:00', '2026-11-04T08:00:00', 1)")
    c.commit()
    c.close()
    with open(other, "rb") as fh:
        return fh.read()


def test_no_store_never_overwrites(path):
    before = md5(path)
    s = Syncer(path, None)
    assert s.maybe_sync() is False
    assert s.last_outcome == "no R2" and md5(path) == before


def test_up_to_date_skips_download(path):
    store = SpyStore()
    with open(path, "rb") as fh:
        store.put(writer.DB_KEY, fh.read())
    s = Syncer(path, store)
    assert s.maybe_sync() is False
    assert s.last_outcome == "up to date" and store.get_calls == 0


def test_changed_downloads(tmp_path, path):
    store = SpyStore()
    new = _with_extra_activity(tmp_path, path)
    store.put(writer.DB_KEY, new)
    s = Syncer(path, store)
    assert s.maybe_sync() is True
    assert s.last_outcome == "downloaded"
    with open(path, "rb") as fh:
        assert fh.read() == new


def test_missing_local_file_downloads(tmp_path, path):
    store = SpyStore()
    with open(path, "rb") as fh:
        store.put(writer.DB_KEY, fh.read())
    target = str(tmp_path / "fresh" / "activities.sqlite")
    assert Syncer(target, store).maybe_sync() is True


def test_no_database_in_r2(path):
    s = Syncer(path, SpyStore())
    assert s.maybe_sync() is False and s.last_outcome == "no database in R2"


def test_interval_respected(path):
    store = SpyStore()
    t = [0.0]
    s = Syncer(path, store, clock=lambda: t[0])
    s.maybe_sync()
    t[0] = 100
    s.maybe_sync()
    assert store.head_calls == 1
    t[0] = 3700
    s.maybe_sync()
    assert store.head_calls == 2


def test_force_ignores_interval(path):
    store = SpyStore()
    s = Syncer(path, store, clock=lambda: 0.0)
    s.maybe_sync()
    s.maybe_sync(force=True)
    assert store.head_calls == 2


def test_failure_keeps_local(path):
    before = md5(path)
    s = Syncer(path, FailingStore())
    assert s.maybe_sync() is False
    assert s.last_outcome.startswith("failed:") and "network down" in s.last_outcome
    assert md5(path) == before


def test_reopen_reads_new_file(tmp_path, path):  # Review Focus 1
    db = Database(path)
    store = MemoryStore()
    store.put(writer.DB_KEY, _with_extra_activity(tmp_path, path))
    assert Syncer(path, store).maybe_sync()
    db.reopen()
    assert db.conn.execute("select count(*) from activities where id='extra'").fetchone()[0] == 1
    db.close()


def test_as_of(path):
    db = Database(path)
    s = Syncer(path, None, clock=lambda: 1_793_750_400.0)  # 2026-11-04T00:00:00Z
    s.maybe_sync()
    a = as_of(db, s)
    assert a["newest_activity"] == "2026-01-01T00:30:00"
    assert a["newest_wellness_day"] == "2025-03-16"
    assert a["series_through"] == {"hr": "2025-03-10"}
    assert a["last_sync_check"] == "2026-11-04T00:00:00Z"
    assert a["sync"] == "no R2"
    db.close()
