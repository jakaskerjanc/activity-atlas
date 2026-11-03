"""The daily fetch and a Garmin export import working on the same database:
deletions each one saw must respect when the other's data was observed."""
import json
import os
import shutil
import sys
import time
import warnings
import zipfile

import pytest

from ingest import archive as archive_mod
from ingest import db, strava_import, sync, writer
from ingest import garmin_fetch as gf
from ingest.archive import LocalArchive
from ingest.garmin_api import GarminAuthError
from ingest.garmin_import import GarminImporter
from ingest.objstore import MemoryStore
from ingest.tests.test_strava_import import GYM, HEADER, _zip as _strava_zip
from ingest.tests.test_garmin_fetch import FakeClient, _downloads, _list


def _fetch(dbp, arch, items, now):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return gf.GarminFetcher(dbp, arch, delay_s=0, client=FakeClient(items, _downloads()), now=now).run()


def _summary(item):
    return {"activityId": item["activityId"], "name": item["activityName"],
            "activityType": item["activityType"]["typeKey"],
            "startTimeGmt": int(gf.gmt_to_epoch(item["startTimeGMT"])) * 1000,
            "distance": (item.get("distance") or 0) * 100, "duration": item["duration"] * 1000}


def _export(tmp_path, summaries, made):
    path = tmp_path / "export.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("DI_CONNECT/DI-Connect-Fitness/u_summarizedActivities.json", date_time=made),
                    json.dumps([summaries]))
    return str(path)


def _source(dbp, pid):
    conn = db.connect(dbp)
    row = conn.execute("SELECT s.deleted_at, a.visible FROM activity_sources s JOIN activities a "
                       "ON a.id = s.activity_id WHERE s.provider='garmin' AND s.provider_activity_id=?",
                       (pid,)).fetchone()
    conn.close()
    return row["deleted_at"], row["visible"]


def test_export_made_before_a_fetched_deletion_does_not_bring_it_back(tmp_path):
    dbp, arch = str(tmp_path / "a.sqlite"), LocalArchive(str(tmp_path / "arch"))
    _fetch(dbp, arch, _list(), "2026-09-20T10:00:00+00:00")
    _fetch(dbp, arch, _list()[:1], "2026-09-21T10:00:00+00:00")   # the gym was deleted in Garmin
    assert _source(dbp, "5000002") == ("2026-09-21T10:00:00+00:00", 0)
    export = _export(tmp_path, [_summary(i) for i in _list()], made=(2026, 9, 15, 0, 0, 0))
    GarminImporter(export, dbp, arch, now="2026-09-22T10:00:00+00:00").run()
    assert _source(dbp, "5000002") == ("2026-09-21T10:00:00+00:00", 0)


def test_export_does_not_delete_an_activity_first_seen_after_it_was_made(tmp_path):
    dbp, arch = str(tmp_path / "a.sqlite"), LocalArchive(str(tmp_path / "arch"))
    _fetch(dbp, arch, _list(), "2026-09-20T10:00:00+00:00")   # the gym synced late, after the export
    earlier = dict(_list()[0], activityId=5000000, activityName="Earlier Walk",
                   startTimeGMT="2026-09-10 08:00:00")   # puts the gym inside the export's date range
    export = _export(tmp_path, [_summary(earlier), _summary(_list()[0])], made=(2026, 9, 15, 0, 0, 0))
    GarminImporter(export, dbp, arch, now="2026-09-22T10:00:00+00:00").run()
    assert _source(dbp, "5000002") == (None, 1)


# Export zips carry local time read as UTC: an export made at 10:00 UTC in
# UTC+2 says 12:00. Comparisons with real UTC fetch times leave a margin.

def test_export_clock_skew_does_not_delete_an_activity_fetched_after_it(tmp_path):
    dbp, arch = str(tmp_path / "a.sqlite"), LocalArchive(str(tmp_path / "arch"))
    _fetch(dbp, arch, _list(), "2026-09-20T11:00:00+00:00")   # the gym synced after the export was made
    earlier = dict(_list()[0], activityId=5000000, activityName="Earlier Walk",
                   startTimeGMT="2026-09-10 08:00:00")
    export = _export(tmp_path, [_summary(earlier), _summary(_list()[0])], made=(2026, 9, 20, 12, 0, 0))
    GarminImporter(export, dbp, arch, now="2026-09-22T10:00:00+00:00").run()
    assert _source(dbp, "5000002") == (None, 1)


def test_export_clock_skew_does_not_bring_back_a_later_fetched_deletion(tmp_path):
    dbp, arch = str(tmp_path / "a.sqlite"), LocalArchive(str(tmp_path / "arch"))
    _fetch(dbp, arch, _list(), "2026-09-20T08:00:00+00:00")
    _fetch(dbp, arch, _list()[:1], "2026-09-20T11:00:00+00:00")   # deleted after the export was made
    export = _export(tmp_path, [_summary(i) for i in _list()], made=(2026, 9, 20, 12, 0, 0))
    GarminImporter(export, dbp, arch, now="2026-09-22T10:00:00+00:00").run()
    assert _source(dbp, "5000002") == ("2026-09-20T11:00:00+00:00", 0)


class _FakeApi(FakeClient):
    """Stands in for GarminPersonalApi: the fake client plus authenticate()."""

    def __init__(self, **kw):
        super().__init__(_list(), _downloads())

    def authenticate(self):
        pass


def _r2(monkeypatch, tmp_path):
    monkeypatch.setattr(time, "sleep", lambda s: None)    # the fetch paces its API calls
    store = MemoryStore()
    store.bucket = "bkt"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("R2_BUCKET", "bkt")
    monkeypatch.setattr(archive_mod, "store_from_env", lambda: store)
    return store


def _activity_ids(path):
    conn = db.connect(path)
    try:
        return {(r[0], r[1]): r[2] for r in conn.execute(
            "SELECT provider, provider_activity_id, activity_id FROM activity_sources")}
    finally:
        conn.close()


def test_import_then_fetch_through_r2(tmp_path, monkeypatch):
    store = _r2(monkeypatch, tmp_path)
    local = str(tmp_path / "data" / "activities.sqlite")
    monkeypatch.setattr(sys, "argv", ["strava_import", _strava_zip(tmp_path, HEADER + GYM, {}),
                                       "--db", local, "--init-db"])
    strava_import.main()
    after_import = _activity_ids(local)
    assert list(after_import) == [("strava", "222")]

    monkeypatch.setattr(gf, "GarminPersonalApi", _FakeApi)
    monkeypatch.setattr(sys, "argv", ["garmin_fetch", "--db", local])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        gf.main()

    os.remove(local)
    shutil.rmtree(tmp_path / "data" / "cache")
    monkeypatch.setattr(sys, "argv", ["sync", "--db", local])
    sync.main()
    synced = _activity_ids(local)
    assert {("strava", "222"), ("garmin", "5000001"), ("garmin", "5000002")} <= set(synced)
    assert synced[("strava", "222")] == after_import[("strava", "222")]
    assert store.head(writer.DB_KEY) is not None


def test_fetch_without_remote_db_exits_6(tmp_path, monkeypatch, capsys):
    store = _r2(monkeypatch, tmp_path)
    monkeypatch.setattr(gf, "GarminPersonalApi", _FakeApi)
    monkeypatch.setattr(sys, "argv", ["garmin_fetch", "--db", str(tmp_path / "db.sqlite")])
    with pytest.raises(SystemExit) as exc:
        gf.main()
    assert exc.value.code == 6
    assert "--init-db" in capsys.readouterr().err
    assert store.head(writer.DB_KEY) is None


def _failing_wellness_api(error):
    class Api(_FakeApi):
        def get_raw(self, path, params=None):
            raise error
    return Api


def _seed_r2_db(store, tmp_path):
    path = str(tmp_path / "seed.sqlite")
    db.open_db(path).close()
    store.put(writer.DB_KEY, open(path, "rb").read())


def _r2_activities(store, tmp_path):
    path = str(tmp_path / "from-r2.sqlite")
    open(path, "wb").write(store.get(writer.DB_KEY)[0])
    return {pid for (_, pid) in _activity_ids(path)}


@pytest.mark.parametrize("error, code", [(RuntimeError("boom"), 1), (GarminAuthError("401"), 3)])
def test_interrupted_fetch_still_uploads_what_it_committed(tmp_path, monkeypatch, error, code):
    store = _r2(monkeypatch, tmp_path)
    _seed_r2_db(store, tmp_path)
    monkeypatch.setattr(gf, "GarminPersonalApi", _failing_wellness_api(error))
    monkeypatch.setattr(sys, "argv", ["garmin_fetch", "--db", str(tmp_path / "db.sqlite")])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with pytest.raises(BaseException) as exc:
            gf.main()
    # (a GarminApiError is retried per endpoint by the wellness fetch and never aborts the run)
    if code == 3:
        assert isinstance(exc.value, SystemExit) and exc.value.code == 3
    else:
        assert exc.value is error
    assert _r2_activities(store, tmp_path) == {"5000001", "5000002"}
    assert any(k.startswith(writer.SNAPSHOT_PREFIX) for k, _ in store.list(writer.SNAPSHOT_PREFIX))
