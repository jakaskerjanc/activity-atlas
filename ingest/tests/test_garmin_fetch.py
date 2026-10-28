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
from ingest.garmin_api import GarminAuthError
from ingest.parse.dispatch import parse_bytes
from ingest.parse.fit import parse_fit
from ingest.records import SourceRecord

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _list():
    with open(os.path.join(FIX, "garmin_api_list.json")) as fh:
        return json.load(fh)


def _live_list():
    """List payload shaped like the live Personal API DTO: no hasPolyline."""
    return [{k: v for k, v in item.items() if k != "hasPolyline"} for item in _list()]


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

    def list_activities_raw(self, start, limit):
        self.list_calls.append((start, limit))
        return json.dumps(self.items[start:start + limit], indent=1).encode()

    def download_activity(self, activity_id):
        self.download_calls.append(activity_id)
        if isinstance(self.download, Exception):
            raise self.download
        return self.download


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


def _fetcher(tmp_path, client, **kw):
    return gf.GarminFetcher(str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch")),
                            delay_s=0, client=client, now="2026-10-27T10:00:00+00:00", **kw)


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
    client = FakeClient(_list(), _zip("outdoor.fit"))
    assert _fetcher(tmp_path, client).run() == {"insert": 2, "update": 0, "merge": 0}

    run, gym = _by_id(tmp_path, "5000001"), _by_id(tmp_path, "5000002")
    assert run["type"] == "Run" and run["polyline"] != ""
    assert run["distance"] == 10006.79 and run["moving_time"] == 3200
    assert gym["moving_time"] == 2400
    assert gym["polyline"] == ""
    assert client.download_calls == [5000001]

    client2 = FakeClient(_list(), _zip("outdoor.fit"))
    assert _fetcher(tmp_path, client2).run() == {
        "insert": 0, "update": 0, "merge": 0
    }
    assert client2.download_calls == []


def test_multi_page_list_fetches_all_pages(tmp_path):
    items = [{
        "activityId": 7000000 + n,
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(5)]
    client = FakeClient(items, RuntimeError("must not download"))
    assert _fetcher(tmp_path, client, page_size=2).run() == {"insert": 5, "update": 0, "merge": 0}
    assert client.list_calls == [(0, 2), (2, 2), (4, 2)]
    assert client.download_calls == []
    assert _count(tmp_path) == 5


def test_live_dto_without_has_polyline_downloads_by_start_coordinates(tmp_path):
    items = _live_list()
    assert all("hasPolyline" not in item for item in items)
    client = FakeClient(items, _zip("outdoor.fit"))
    assert _fetcher(tmp_path, client).run() == {
        "insert": 2, "update": 0, "merge": 0
    }
    assert client.download_calls == [5000001]
    assert _by_id(tmp_path, "5000001")["polyline"] != ""
    assert _by_id(tmp_path, "5000002")["polyline"] == ""


def test_legacy_has_polyline_signal_downloads_without_start_coordinates(tmp_path):
    outdoor, _ = _list()
    legacy = {k: v for k, v in outdoor.items()
              if k not in ("startLatitude", "startLongitude")}
    legacy["hasPolyline"] = True
    client = FakeClient([legacy], _zip("outdoor.fit"))
    assert _fetcher(tmp_path, client).run() == {
        "insert": 1, "update": 0, "merge": 0
    }
    assert client.download_calls == [5000001]
    assert _by_id(tmp_path, "5000001")["polyline"] != ""


@pytest.mark.parametrize("item, expected", [
    ({}, False),
    ({"hasPolyline": True}, True),
    ({"hasPolyline": False}, False),
    ({"startLatitude": 46.05, "startLongitude": 14.5}, True),
    ({"startLatitude": 46.05, "startLongitude": None}, False),
    ({"startLatitude": None, "startLongitude": 14.5}, False),
    ({"hasPolyline": False, "startLatitude": 46.05, "startLongitude": 14.5}, True),
])
def test_has_gps_hint(item, expected):
    assert gf.has_gps_hint(item) is expected


def test_download_failure_is_not_persisted_and_retried(tmp_path):
    import warnings

    bad = FakeClient(_list(), RuntimeError("boom"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert _fetcher(tmp_path, bad).run() == {
            "insert": 1, "update": 0, "merge": 0
        }
    assert _by_id(tmp_path, "5000001") is None
    assert _by_id(tmp_path, "5000002") is not None
    assert not list((tmp_path / "arch" / "records" / "garmin").glob("5000001"))

    good = FakeClient(_list(), _zip("outdoor.fit"))
    assert _fetcher(tmp_path, good).run() == {
        "insert": 1, "update": 0, "merge": 0
    }
    assert _by_id(tmp_path, "5000001")["polyline"] != ""


def test_three_consecutive_download_failures_stop_run(tmp_path):
    import warnings

    base, _ = _list()
    items = [{
        **base,
        "activityId": 6000000 + n,
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(4)]
    assert all(gf.has_gps_hint(item) for item in items)

    client = FakeClient(items, RuntimeError("boom"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert _fetcher(tmp_path, client).run() == {
            "insert": 0, "update": 0, "merge": 0
        }
    assert client.download_calls == [6000000, 6000001, 6000002]
    assert _count(tmp_path) == 0


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
    client = FakeClient(_list(), zipped)
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
    client = FakeClient(items, RuntimeError("must not download"))
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
    client = FakeClient(_list(), _zip("outdoor.fit"))
    assert _fetcher(tmp_path, client).run() == {"insert": 1, "update": 0, "merge": 1}
    assert _count(tmp_path) == 2                                    # merged run + gym
    assert _by_id(tmp_path, "5000001")["name"] == "Strava Run"
