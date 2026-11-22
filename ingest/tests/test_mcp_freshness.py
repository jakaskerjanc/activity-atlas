import hashlib
import os
import time

import pytest

from ingest import writer
from ingest.mcp_server.database import Database
from ingest.mcp_server.freshness import Syncer, as_of, notice
from ingest.objstore import MemoryStore
from ingest.tests.mcp_fixture import build_fixture_db, slow_store, with_extra_activity


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
    new = with_extra_activity(tmp_path, path)
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
    store.put(writer.DB_KEY, with_extra_activity(tmp_path, path))
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


def test_start_downloads_in_the_background(tmp_path, path):
    store = slow_store(tmp_path, path)
    before = md5(path)
    s = Syncer(path, store)
    t0 = time.monotonic()
    assert s.start() is True
    assert time.monotonic() - t0 < 0.5
    assert store.started.wait(5)
    assert s.last_outcome == "downloading a newer database (1 of 3 MB)"
    assert md5(path) == before  # nothing installed until the download is complete
    assert s.start(force=True) is True and s.wait(0.05) is False  # no second download
    store.release.set()
    assert s.wait(5) is True
    assert s.last_outcome == "downloaded" and md5(path) != before


def test_start_respects_interval(path):
    store = SpyStore()
    t = [0.0]
    s = Syncer(path, store, clock=lambda: t[0])
    assert s.start() is True and s.wait(5)
    t[0] = 100
    assert s.start() is False
    assert s.start(force=True) is True and s.wait(5)
    assert store.head_calls == 2


def test_stop_abandons_the_download_and_its_temp_file(tmp_path, path):
    store = slow_store(tmp_path, path)
    before = md5(path)
    s = Syncer(path, store)
    s.start()
    assert store.started.wait(5)
    s.stop()
    assert s.wait(0) and s.last_outcome == "stopped"
    assert md5(path) == before
    assert [f for f in os.listdir(os.path.dirname(path)) if ".pull-" in f] == []


def test_notice_says_when_the_answer_is_stale(tmp_path, path):
    db = Database(path)
    store = slow_store(tmp_path, path)
    s = Syncer(path, store)
    assert notice(db, s) is None  # not checked yet: nothing known to be wrong
    s.start()
    assert store.started.wait(5)
    assert notice(db, s) == ("The local database is out of date: a newer one is downloading from R2 "
                             "(1 of 3 MB). This answer is from the older copy.")
    assert as_of(db, s)["sync"] == "downloading a newer database (1 of 3 MB)"
    store.release.set()
    s.wait(5)
    assert "arrived during this call" in notice(db, s)
    db.reopen()
    assert notice(db, s) is None and as_of(db, s)["sync"] == "downloaded"
    db.close()


def test_notice_for_checking_failed_and_up_to_date(path):
    db = Database(path)
    s = Syncer(path, None)
    for outcome, expected in [("checking", "Still checking R2"), ("failed: network down", "Could not check R2"),
                              ("up to date", None), ("no R2", None)]:
        s.last_outcome = outcome
        line = notice(db, s)
        assert (line is None) if expected is None else line.startswith(expected)
    db.close()


def test_notice_without_a_database(path):
    s = Syncer(path, None)
    s.last_outcome, s.progress = "downloading a newer database (12 of 46 MB)", "12 of 46 MB"
    assert notice(None, s) == ("There is no local database yet: it is being downloaded from R2 (12 of 46 MB). "
                               "Try again in a minute.")
    s.last_outcome = "failed: network down"
    assert "could not be downloaded (failed: network down). Call sync" in notice(None, s)


def test_wait_checked_returns_once_the_download_starts(tmp_path, path):
    store = slow_store(tmp_path, path)
    s = Syncer(path, store)
    s.start()
    t0 = time.monotonic()
    s.wait_checked(5)
    assert time.monotonic() - t0 < 2 and s.last_outcome.startswith("downloading")
    store.release.set()
    s.wait(5)


def test_wait_checked_without_r2_does_not_wait(path):
    s = Syncer(path, None)
    s.start()
    t0 = time.monotonic()
    s.wait_checked(5)
    assert time.monotonic() - t0 < 0.5 and s.last_outcome == "no R2"
