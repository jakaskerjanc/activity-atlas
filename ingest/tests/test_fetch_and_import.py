"""The daily fetch and a Garmin export import working on the same database:
deletions each one saw must respect when the other's data was observed."""
import json
import warnings
import zipfile

from ingest import db
from ingest import garmin_fetch as gf
from ingest.archive import LocalArchive
from ingest.garmin_import import GarminImporter
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
