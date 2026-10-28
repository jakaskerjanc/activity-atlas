import hashlib
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import pytest

from ingest import db as dbm
from ingest import garmin_fetch as gf
from ingest.archive import LocalArchive
from ingest.garmin_api import GarminApiError, GarminAuthError
from ingest.parse.dispatch import parse_bytes
from ingest.parse.fit import parse_fit
from ingest.records import SourceRecord

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
        self.wellness, self.wellness_calls = {}, []      # path -> bytes | Exception | callable(params)

    def list_activities_raw(self, start, limit):
        self.list_calls.append((start, limit))
        return json.dumps(self.items[start:start + limit], indent=1).encode()

    def download_activity(self, activity_id):
        self.download_calls.append(activity_id)
        result = self.download[activity_id] if isinstance(self.download, dict) else self.download
        if isinstance(result, Exception):
            raise result
        return result

    def get_raw(self, path, params=None):
        self.wellness_calls.append((path, params))
        result = self.wellness.get(path, b"")
        if isinstance(result, Exception):
            raise result
        return result(params) if callable(result) else result


def _track(data):
    return parse_bytes(*gf.extract_activity_file(data)).track


def test_extract_track_from_zip_reads_fit():
    track = _track(_zip("outdoor.fit"))
    assert len(track) == len(parse_fit(io.BytesIO(_fixture_bytes("outdoor.fit"))).track)


def test_extract_track_from_zip_reads_tcx():
    assert _track(_zip("sample.tcx")) == [
        (46.05, 14.5),
        (46.051, 14.501),
    ]


def test_extract_track_from_zip_reads_gpx():
    assert _track(_zip("sample.gpx")) == [
        (46.05, 14.5),
        (46.051, 14.501),
        (46.052, 14.502),
    ]


def test_extract_track_from_zip_prefers_fit():
    name, data = gf.extract_activity_file(_zip("sample.tcx", "outdoor.fit"))
    assert name == "activity.fit" and data == _fixture_bytes("outdoor.fit")
    track = _track(_zip("sample.tcx", "outdoor.fit"))
    assert len(track) == len(parse_fit(io.BytesIO(_fixture_bytes("outdoor.fit"))).track)


def test_extract_track_from_zip_rejects_unknown_file():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "nope")
    with pytest.raises(ValueError):
        gf.extract_activity_file(buf.getvalue())


def test_gmt_to_dt_is_utc():
    dt = gf.gmt_to_dt("2026-09-12 06:30:00")
    assert dt == datetime(2026, 9, 12, 6, 30, tzinfo=timezone.utc)
    assert gf.gmt_to_epoch("2026-09-12 06:30:00") == int(dt.timestamp())


def test_filter_after_is_strictly_after():
    items = _list()
    boundary = gf.gmt_to_epoch("2026-09-12 06:30:00")
    assert gf.filter_after(items, boundary) == []
    assert [i["activityId"] for i in gf.filter_after(items, boundary - 1)] == [5000001]


def _record(item, file_sha=None, file_name=None):
    return SourceRecord("garmin", str(item["activityId"]), "2026-10-27T10:00:00+00:00", item,
                        file_sha, file_name, {"kind": "garmin_api"})


def test_record_to_source_no_unit_scaling():
    outdoor, indoor = _list()
    s = gf.record_to_source(_record(outdoor), None)
    assert s.provider == "garmin" and s.provider_activity_id == "5000001"
    assert s.type == "Run" and s.name == "Morning Run"
    assert s.distance_m == 10006.79 and s.reported["elevation_gain_m"] == 34.0
    assert s.moving_s == 3200 and s.elapsed_s == 3300
    assert s.start_time == datetime(2026, 9, 12, 6, 30, tzinfo=timezone.utc)
    assert s.utc_offset_s == 7200 and s.summary == outdoor


def test_record_to_source_fallbacks():
    s = gf.record_to_source(_record({"activityId": 1, "startTimeGMT": "2026-09-12 06:30:00"}), None)
    assert s.type == "Workout" and s.name == "Untitled"
    assert s.distance_m is None and s.moving_s is None and s.elapsed_s is None
    assert s.reported["elevation_gain_m"] is None and s.utc_offset_s is None


def test_record_to_source_moving_falls_back_to_duration_and_file_fills_gaps():
    _, indoor = _list()
    p = parse_fit(io.BytesIO(_fixture_bytes("indoor.fit")))
    s = gf.record_to_source(_record(indoor), p)
    assert s.moving_s == 2400 and s.reported["avg_hr"] == 95 and s.hr_zones is not None


NOW_OUT = "2026-10-27T10:00:00+00:00"      # both fixture activities are older than the re-check window
NOW_IN = "2026-09-20T10:00:00+00:00"       # and both are inside it here


def _fetcher(tmp_path, client, now=NOW_OUT, **kw):
    return gf.GarminFetcher(str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch")),
                            delay_s=0, client=client, now=now, **kw)


def _downloads():
    return {5000001: _zip("outdoor.fit"), 5000002: _zip("indoor.fit")}


def _zip_with_only_text():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "no activity here")
    return buf.getvalue()


WELLNESS_PATH = "/usersummary-service/v2/dailysummaries"
NO_FILE = GarminApiError("no file", status=404)


def _record_files(tmp_path, pid):
    return list((tmp_path / "arch" / "records" / "garmin" / str(pid)).glob("*.json"))


def _by_id(tmp_path, pid):
    conn = dbm.connect(str(tmp_path / "db.sqlite"))
    try:
        return conn.execute(
            "SELECT a.* FROM activities a JOIN activity_sources s ON s.activity_id = a.id "
            "WHERE s.provider='garmin' AND s.provider_activity_id=?", (pid,)).fetchone()
    finally:
        conn.close()


def _count(tmp_path):
    conn = dbm.connect(str(tmp_path / "db.sqlite"))
    try:
        return conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
    finally:
        conn.close()


def test_run_inserts_with_geometry_and_windows_on_rerun(tmp_path):
    client = FakeClient(_list(), {5000001: _zip("outdoor.fit"), 5000002: NO_FILE})
    assert _fetcher(tmp_path, client).run() == {"insert": 2, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}

    run, gym = _by_id(tmp_path, "5000001"), _by_id(tmp_path, "5000002")
    assert run["type"] == "Run" and run["polyline"] != ""
    assert run["distance"] == 10006.79 and run["moving_time"] == 3200
    assert gym["moving_time"] == 2400
    assert gym["polyline"] == ""
    assert client.download_calls == [5000001, 5000002]

    client2 = FakeClient(_list(), {5000001: _zip("outdoor.fit"), 5000002: NO_FILE})
    assert _fetcher(tmp_path, client2).run() == {"insert": 0, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert client2.download_calls == []


def test_run_downloads_every_new_activity_including_indoor(tmp_path):
    client = FakeClient(_list(), _downloads())
    assert _fetcher(tmp_path, client).run() == {"insert": 2, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert client.download_calls == [5000001, 5000002]
    gym = _by_id(tmp_path, "5000002")
    assert gym["has_hr"] == 1 and gym["polyline"] == ""
    assert _by_id(tmp_path, "5000001")["polyline"] != ""


def test_multi_page_list_fetches_all_pages(tmp_path):
    items = [{
        "activityId": 7000000 + n,
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(5)]
    client = FakeClient(items, NO_FILE)
    assert _fetcher(tmp_path, client, page_size=2).run() == {
        "insert": 5, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert client.list_calls == [(0, 2), (2, 2), (4, 2)]
    assert client.download_calls == [7000000 + n for n in range(5)]
    assert _count(tmp_path) == 5


def test_download_failure_is_not_persisted_and_retried(tmp_path):
    import warnings

    bad = FakeClient(_list(), {5000001: RuntimeError("boom"), 5000002: _zip("indoor.fit")})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert _fetcher(tmp_path, bad).run() == {"insert": 1, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert _by_id(tmp_path, "5000001") is None
    assert _by_id(tmp_path, "5000002") is not None
    assert _record_files(tmp_path, 5000001) == []

    good = FakeClient(_list(), _downloads())
    assert _fetcher(tmp_path, good).run() == {"insert": 1, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert good.download_calls == [5000001]
    assert _by_id(tmp_path, "5000001")["polyline"] != ""


def test_three_consecutive_download_failures_stop_run(tmp_path):
    import warnings

    base, _ = _list()
    items = [{
        **base,
        "activityId": 6000000 + n,
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(4)]

    client = FakeClient(items, RuntimeError("boom"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert _fetcher(tmp_path, client).run() == {
            "insert": 0, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert client.download_calls == [6000000, 6000001, 6000002]
    assert _count(tmp_path) == 0


def test_recheck_unchanged_dto_downloads_nothing(tmp_path):
    first = FakeClient(_list(), _downloads())
    assert _fetcher(tmp_path, first, NOW_IN).run()["insert"] == 2
    files = _record_files(tmp_path, 5000001) + _record_files(tmp_path, 5000002)

    second = FakeClient(_list(), _downloads())
    counts = _fetcher(tmp_path, second, "2026-09-21T10:00:00+00:00").run()
    assert counts == {"insert": 0, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert second.download_calls == []
    assert _record_files(tmp_path, 5000001) + _record_files(tmp_path, 5000002) == files


def test_recheck_changed_dto_updates_in_place(tmp_path):
    _fetcher(tmp_path, FakeClient(_list(), _downloads()), NOW_IN).run()
    activity_id = _by_id(tmp_path, "5000001")["id"]

    renamed = _list()
    renamed[0]["activityName"] = "Renamed"
    second = FakeClient(renamed, _downloads())
    counts = _fetcher(tmp_path, second, "2026-09-21T10:00:00+00:00").run()
    assert counts["update"] == 1 and counts["insert"] == 0
    assert second.download_calls == [5000001]
    run = _by_id(tmp_path, "5000001")
    assert run["id"] == activity_id and run["name"] == "Renamed"
    assert len(_record_files(tmp_path, 5000001)) == 2


def test_recheck_missing_activity_is_marked_deleted(tmp_path):
    _fetcher(tmp_path, FakeClient(_list(), _downloads()), NOW_IN).run()
    later = "2026-09-21T10:00:00+00:00"
    counts = _fetcher(tmp_path, FakeClient(_list()[:1], _downloads()), later).run()
    assert counts["deleted"] == 1
    conn = dbm.connect(str(tmp_path / "db.sqlite"))
    try:
        deleted_at = conn.execute(
            "SELECT deleted_at FROM activity_sources WHERE provider_activity_id='5000002'").fetchone()[0]
    finally:
        conn.close()
    assert deleted_at == later
    assert _by_id(tmp_path, "5000002")["visible"] == 0
    assert _by_id(tmp_path, "5000001")["visible"] == 1


def test_activity_outside_window_is_not_deleted(tmp_path):
    import warnings

    _fetcher(tmp_path, FakeClient(_list(), _downloads()), NOW_IN).run()
    # A non-empty list rules out the empty-list guard: only the window protects these.
    fresh = {"activityId": 5000003, "activityName": "Fresh", "activityType": {"typeKey": "strength_training"},
             "startTimeGMT": "2026-11-25 06:00:00", "duration": 1800.0}
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        counts = _fetcher(tmp_path, FakeClient([fresh], {5000003: NO_FILE}),
                          "2026-11-30T10:00:00+00:00").run()
    assert counts["deleted"] == 0 and counts["insert"] == 1
    assert _by_id(tmp_path, "5000001")["visible"] == 1 and _by_id(tmp_path, "5000002")["visible"] == 1


def test_empty_recheck_list_deletes_nothing(tmp_path):
    _fetcher(tmp_path, FakeClient(_list(), _downloads()), NOW_IN).run()
    with pytest.warns(UserWarning, match="re-check listed no Garmin activities in the last 30 days; "
                                         "marking nothing deleted"):
        counts = _fetcher(tmp_path, FakeClient([], _downloads()), "2026-09-21T10:00:00+00:00").run()
    assert counts["deleted"] == 0
    assert _by_id(tmp_path, "5000001")["visible"] == 1 and _by_id(tmp_path, "5000002")["visible"] == 1


def test_manual_activity_without_file_is_stored_and_not_retried(tmp_path):
    manual = [{
        "activityId": 8000000 + n,
        "activityName": f"Manual {n}",
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": f"2026-09-{16 - n:02d} 06:00:00",
        "duration": 1800.0,
    } for n in range(3)]
    items = manual + _list()[:1]
    download = {m["activityId"]: NO_FILE for m in manual[:2]}
    download[manual[2]["activityId"]] = _zip_with_only_text()
    download[5000001] = _zip("outdoor.fit")

    first = FakeClient(items, download)
    assert _fetcher(tmp_path, first, NOW_IN).run() == {
        "insert": 4, "update": 0, "merge": 0, "deleted": 0, "wellness_days": 0}
    assert len(first.download_calls) == 4
    assert _count(tmp_path) == 4
    assert _by_id(tmp_path, "5000001")["polyline"] != ""

    second = FakeClient(items, download)
    assert _fetcher(tmp_path, second, "2026-09-21T10:00:00+00:00").run()["insert"] == 0
    assert second.download_calls == []


def test_zip_without_activity_file_is_stored_without_file_and_not_retried(tmp_path):
    zipped = _zip_with_only_text()
    items = _list()[:1]

    first = FakeClient(items, zipped)
    assert _fetcher(tmp_path, first, NOW_IN).run()["insert"] == 1
    (rec,) = LocalArchive(str(tmp_path / "arch")).list_records()
    assert rec.file_sha256 is None and rec.origin["zip_sha"] == hashlib.sha256(zipped).hexdigest()
    assert _by_id(tmp_path, "5000001")["polyline"] == ""

    second = FakeClient(items, zipped)
    assert _fetcher(tmp_path, second, "2026-09-21T10:00:00+00:00").run()["insert"] == 0
    assert second.download_calls == []


def test_value_error_from_download_is_a_failure_not_a_missing_file(tmp_path):
    client = FakeClient(_list()[:1], ValueError("bad id"))
    with pytest.warns(UserWarning, match="download failed for 5000001: bad id"):
        counts = _fetcher(tmp_path, client, NOW_IN).run()
    assert counts["insert"] == 0
    assert _by_id(tmp_path, "5000001") is None
    assert _record_files(tmp_path, 5000001) == []


def test_failed_redownload_keeps_previous_record(tmp_path):
    import warnings

    _fetcher(tmp_path, FakeClient(_list(), _downloads()), NOW_IN).run()
    before = _by_id(tmp_path, "5000001")

    renamed = _list()
    renamed[0]["activityName"] = "Renamed"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        counts = _fetcher(tmp_path, FakeClient(renamed, {5000001: RuntimeError("boom")}),
                          "2026-09-21T10:00:00+00:00").run()
    assert counts["update"] == 0 and counts["deleted"] == 0
    after = _by_id(tmp_path, "5000001")
    assert after["name"] == before["name"] == "Morning Run"
    assert after["polyline"] == before["polyline"] != ""
    assert after["visible"] == 1
    assert len(_record_files(tmp_path, 5000001)) == 1


def test_auth_error_during_download_aborts(tmp_path):
    client = FakeClient(_list(), GarminAuthError("401"))
    with pytest.raises(GarminAuthError):
        _fetcher(tmp_path, client).run()


def test_auth_error_mid_run_exits_3(monkeypatch, tmp_path, capsys):
    class FakeFetcher:
        def __init__(self, *args, **kwargs): pass
        def authenticate(self): pass
        def run(self): raise GarminAuthError("401 mid-run")

    monkeypatch.setattr(gf, "GarminFetcher", FakeFetcher)
    monkeypatch.setattr(sys, "argv", [
        "garmin_fetch", "--db", str(tmp_path / "db.sqlite"),
    ])
    with pytest.raises(SystemExit) as exc:
        gf.main()
    assert exc.value.code == 3
    assert "Personal API key rejected" in capsys.readouterr().err


def test_wellness_auth_error_keeps_activities(tmp_path):
    client = FakeClient(_list(), _downloads())
    client.wellness[WELLNESS_PATH] = GarminAuthError("401")
    with pytest.raises(GarminAuthError):
        _fetcher(tmp_path, client).run()
    assert _count(tmp_path) == 2


def test_run_applies_wellness_after_the_activities(tmp_path):
    client = FakeClient(_list(), _downloads())
    client.wellness[WELLNESS_PATH] = lambda p: (
        b'[{"calendarDate": "2026-10-27", "totalSteps": 9000}]' if p["startDate"] == "2026-10-27" else b"")
    assert _fetcher(tmp_path, client).run()["wellness_days"] == 1
    conn = dbm.connect(str(tmp_path / "db.sqlite"))
    try:
        assert conn.execute("SELECT steps FROM daily_stats WHERE date='2026-10-27'").fetchone()[0] == 9000
    finally:
        conn.close()


def test_wellness_since_reaches_the_endpoints(tmp_path):
    client = FakeClient(_list(), _downloads())
    _fetcher(tmp_path, client, wellness_since="2026-10-20").run()
    starts = {p["startDate"] for path, p in client.wellness_calls if path == WELLNESS_PATH}
    assert min(starts) == "2026-10-20" and len(starts) == 8


def test_main_passes_wellness_since(monkeypatch, tmp_path):
    seen = {}

    class FakeFetcher:
        def __init__(self, *args, **kwargs): seen.update(kwargs)
        def authenticate(self): pass
        def run(self): return {}

    monkeypatch.setattr(gf, "GarminFetcher", FakeFetcher)
    monkeypatch.setattr(sys, "argv", ["garmin_fetch", "--db", str(tmp_path / "db.sqlite"),
                                      "--wellness-since", "2026-10-01"])
    gf.main()
    assert seen["wellness_since"] == "2026-10-01"


def test_missing_key_exits_2(tmp_path, monkeypatch):
    monkeypatch.delenv("GARMIN_PERSONAL_API_KEY", raising=False)
    fetcher = gf.GarminFetcher(str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch")),
                               key_file=str(tmp_path / "missing"))
    with pytest.raises(SystemExit) as exc:
        fetcher.run()
    assert exc.value.code == 2


def test_rejected_key_exits_3(tmp_path, monkeypatch, capsys):
    class FakeApi:
        def __init__(self, **kw): pass
        def authenticate(self): raise GarminAuthError("401")

    monkeypatch.setattr(gf, "GarminPersonalApi", FakeApi)
    fetcher = gf.GarminFetcher(str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch")))
    with pytest.raises(SystemExit) as exc:
        fetcher.authenticate()
    assert exc.value.code == 3
    err = capsys.readouterr().err
    assert "Settings -> Personal API Key" in err
    assert "connect.garmin.com/app/settings/personalApiToken" in err


def test_fetch_archives_list_page_zip_and_file(tmp_path):
    zipped = _zip("outdoor.fit")
    client = FakeClient(_list(), {5000001: zipped, 5000002: NO_FILE})
    _fetcher(tmp_path, client).run()
    arch = LocalArchive(str(tmp_path / "arch"))
    blobs = {p.name for p in (tmp_path / "arch" / "raw").iterdir()}
    assert len(blobs) == 3                                  # list page, zip, fit
    import hashlib
    page = json.dumps(_list(), indent=1).encode()
    assert hashlib.sha256(page).hexdigest() in blobs        # the page as received
    assert hashlib.sha256(zipped).hexdigest() in blobs
    assert hashlib.sha256(_fixture_bytes("outdoor.fit")).hexdigest() in blobs
    recs = {r.provider_activity_id: r for r in arch.list_records()}
    assert set(recs) == {"5000001", "5000002"}
    assert all(r.origin["kind"] == "garmin_api" for r in recs.values())
    run = recs["5000001"]
    assert run.origin["zip_sha"] == hashlib.sha256(zipped).hexdigest() and run.origin["list_sha"] in blobs
    assert run.file_name == "activity.fit" and run.summary == _list()[0]
    assert _by_id(tmp_path, "5000001")["utc_offset_s"] == 7200    # 08:30 local vs 06:30 GMT
    conn = dbm.connect(str(tmp_path / "db.sqlite"))
    kinds = {r[0]: r[1] for r in conn.execute("SELECT sha256, kind FROM raw_files")}
    assert kinds[run.origin["list_sha"]] == "api_response" and kinds[run.file_sha256] == "activity_file"


def test_list_pages_are_archived_byte_for_byte(tmp_path):
    items = [{
        "activityId": 7000000 + n,
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(3)]
    client = FakeClient(items, NO_FILE)
    _fetcher(tmp_path, client, page_size=2).run()
    arch = LocalArchive(str(tmp_path / "arch"))
    shas = {r.provider_activity_id: r.origin["list_sha"] for r in arch.list_records()}
    pages = [json.dumps(items[:2], indent=1).encode(), json.dumps(items[2:], indent=1).encode()]
    assert arch.get_blob(shas["7000000"]) == arch.get_blob(shas["7000001"]) == pages[0]
    assert arch.get_blob(shas["7000002"]) == pages[1]


def test_fetch_merges_with_existing_strava_activity(tmp_path):
    from ingest.strava_import import StravaImporter
    from ingest.tests.test_strava_import import HEADER, _row, _zip as _strava_zip
    row = _row(111, "Sep 12, 2026, 6:30:00 AM", "Strava Run", "Run", elapsed="3300", distance="10000")
    StravaImporter(_strava_zip(tmp_path, HEADER + row, {}), str(tmp_path / "db.sqlite"),
                   LocalArchive(str(tmp_path / "arch")), now="2026-10-27T09:00:00+00:00").run()
    client = FakeClient(_list(), {5000001: _zip("outdoor.fit"), 5000002: NO_FILE})
    assert _fetcher(tmp_path, client).run() == {"insert": 1, "update": 0, "merge": 1, "deleted": 0, "wellness_days": 0}
    assert _count(tmp_path) == 2                                    # merged run + gym
    assert _by_id(tmp_path, "5000001")["name"] == "Strava Run"
