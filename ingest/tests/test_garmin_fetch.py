import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import pytest

from ingest import garmin_fetch as gf
from ingest.garmin_api import GarminAuthError
from ingest.model import RawActivity
from ingest.parse.fit import parse_fit

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

    def list_activities(self, start, limit):
        self.list_calls.append((start, limit))
        return self.items[start:start + limit]

    def download_activity(self, activity_id):
        self.download_calls.append(activity_id)
        if isinstance(self.download, Exception):
            raise self.download
        return self.download


def test_extract_track_from_zip_reads_fit():
    track = gf.extract_track_from_zip(_zip("outdoor.fit"))
    assert len(track) == len(parse_fit(io.BytesIO(_fixture_bytes("outdoor.fit"))).track)


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
    assert dt == datetime(2026, 9, 12, 6, 30, tzinfo=timezone.utc)
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
    assert gym.moving_time == 2400
    assert gym.polyline == ""
    assert client.download_calls == [5000001]
    conn.close()

    client2 = FakeClient(_list(), _zip("outdoor.fit"))
    assert gf.GarminFetcher(db, delay_s=0, client=client2).run() == {
        "insert": 0, "update": 0, "merge": 0
    }
    assert client2.download_calls == []


def test_multi_page_list_fetches_all_pages(tmp_path):
    from ingest import store

    items = [{
        "activityId": 7000000 + n,
        "activityType": {"typeKey": "strength_training"},
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(5)]
    db = str(tmp_path / "db.sqlite")
    client = FakeClient(items, RuntimeError("must not download"))
    fetcher = gf.GarminFetcher(db, delay_s=0, client=client, page_size=2)
    assert fetcher.run() == {"insert": 5, "update": 0, "merge": 0}
    assert client.list_calls == [(0, 2), (2, 2), (4, 2)]
    assert client.download_calls == []

    conn = store.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == 5
    conn.close()


def test_live_dto_without_has_polyline_downloads_by_start_coordinates(tmp_path):
    from ingest import store

    items = _live_list()
    assert all("hasPolyline" not in item for item in items)
    db = str(tmp_path / "db.sqlite")
    client = FakeClient(items, _zip("outdoor.fit"))
    assert gf.GarminFetcher(db, delay_s=0, client=client).run() == {
        "insert": 2, "update": 0, "merge": 0
    }
    assert client.download_calls == [5000001]

    conn = store.connect(db)
    run = store.find_by_service_id(conn, "garmin", "5000001")
    gym = store.find_by_service_id(conn, "garmin", "5000002")
    assert run.polyline != ""
    assert gym.polyline == ""
    conn.close()


def test_legacy_has_polyline_signal_downloads_without_start_coordinates(tmp_path):
    from ingest import store

    outdoor, _ = _list()
    legacy = {k: v for k, v in outdoor.items()
              if k not in ("startLatitude", "startLongitude")}
    legacy["hasPolyline"] = True
    db = str(tmp_path / "db.sqlite")
    client = FakeClient([legacy], _zip("outdoor.fit"))
    assert gf.GarminFetcher(db, delay_s=0, client=client).run() == {
        "insert": 1, "update": 0, "merge": 0
    }
    assert client.download_calls == [5000001]

    conn = store.connect(db)
    run = store.find_by_service_id(conn, "garmin", "5000001")
    assert run.polyline != ""
    conn.close()


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
    conn = store.connect(db)
    assert store.find_by_service_id(conn, "garmin", "5000001").polyline != ""
    conn.close()


def test_three_consecutive_download_failures_stop_run(tmp_path):
    import warnings
    from ingest import store

    base, _ = _list()
    items = [{
        **base,
        "activityId": 6000000 + n,
        "startTimeGMT": f"2026-09-{10 - n:02d} 06:00:00",
    } for n in range(4)]
    assert all(gf.has_gps_hint(item) for item in items)

    db = str(tmp_path / "db.sqlite")
    client = FakeClient(items, RuntimeError("boom"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert gf.GarminFetcher(db, delay_s=0, client=client).run() == {
            "insert": 0, "update": 0, "merge": 0
        }
    assert client.download_calls == [6000000, 6000001, 6000002]

    conn = store.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == 0
    conn.close()


def test_auth_error_during_download_aborts(tmp_path):
    client = FakeClient(_list(), GarminAuthError("401"))
    with pytest.raises(GarminAuthError):
        gf.GarminFetcher(str(tmp_path / "db.sqlite"), delay_s=0, client=client).run()


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
