import json
import os
from datetime import datetime, timezone

import pytest

from ingest import garmin_fetch as gf
from ingest.model import RawActivity

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _list():
    with open(os.path.join(FIX, "garmin_api_list.json")) as f:
        return json.load(f)


def _detail():
    with open(os.path.join(FIX, "garmin_api_detail.json")) as f:
        return json.load(f)


def test_gmt_to_dt_is_utc():
    dt = gf.gmt_to_dt("2026-09-12 06:30:00")
    assert dt == datetime(2026, 9, 12, 6, 30, 0, tzinfo=timezone.utc)
    assert gf.gmt_to_epoch("2026-09-12 06:30:00") == int(dt.timestamp())


def test_extract_track_maps_lat_lon():
    assert gf.extract_track(_detail())[0] == (46.05, 14.5)
    assert len(gf.extract_track(_detail())) == 4
    assert gf.extract_track({}) == []
    assert gf.extract_track({"geoPolylineDTO": {}}) == []


def test_filter_after_is_strictly_after():
    items = _list()
    boundary = gf.gmt_to_epoch("2026-09-12 06:30:00")  # exact start of item 0
    kept = gf.filter_after(items, boundary)
    assert [i["activityId"] for i in kept] == []       # strict >: equal is excluded
    kept = gf.filter_after(items, boundary - 1)
    assert [i["activityId"] for i in kept] == [5000001]


def test_list_item_to_raw_no_unit_scaling():
    outdoor, indoor = _list()
    r = gf.list_item_to_raw(outdoor, [(46.05, 14.5)])
    assert isinstance(r, RawActivity)
    assert r.source == "garmin" and r.source_id == "5000001"
    assert r.type_raw == "running" and r.name == "Morning Run"
    assert r.distance_m == 10006.79 and r.elevation_gain_m == 34.0
    assert r.moving_time_s == 3200          # movingDuration, seconds, no /1000
    assert r.start_time == datetime(2026, 9, 12, 6, 30, tzinfo=timezone.utc)
    assert r.track == [(46.05, 14.5)] and r.source_file == "garmin-api"


def test_list_item_to_raw_moving_duration_fallback_and_empty_track():
    _, indoor = _list()
    r = gf.list_item_to_raw(indoor, [])
    assert r.moving_time_s == 2400          # movingDuration null -> duration
    assert r.track == [] and r.name == "Gym"


import sys
import types

from ingest import store


class FakeClient:
    """Canned newest-first list (single page) + one detail payload."""
    def __init__(self, items, detail):
        self._items, self._detail = items, detail
        self.list_calls, self.detail_calls = 0, []

    def get_activities(self, start, limit):
        self.list_calls += 1
        return self._items if start == 0 else []

    def get_activity_details(self, activity_id, maxchart, maxpoly):
        self.detail_calls.append((activity_id, maxchart, maxpoly))
        return self._detail

    def dumps(self):
        return '{"di_token": "x"}'


def test_run_inserts_with_geometry_and_windows_on_rerun(tmp_path):
    db = str(tmp_path / "db.sqlite")
    fc = FakeClient(_list(), _detail())
    f = gf.GarminFetcher(db, delay_s=0, client=fc)

    assert f.run() == {"insert": 2, "update": 0, "merge": 0}
    conn = store.connect(db)
    run_row = store.find_by_service_id(conn, "garmin", "5000001")
    gym_row = store.find_by_service_id(conn, "garmin", "5000002")
    assert run_row.type == "Run" and run_row.polyline != ""      # outdoor: geometry present
    assert run_row.distance == 10006.79 and run_row.moving_time == 3200
    assert gym_row.polyline == ""                                 # indoor: hasPolyline false
    assert fc.detail_calls == [(5000001, 1, 20000)]               # detail only for the GPS one
    conn.close()

    # Re-run: high-water now equals the newest start -> strictly-after yields nothing.
    fc2 = FakeClient(_list(), _detail())
    f2 = gf.GarminFetcher(db, delay_s=0, client=fc2)
    assert f2.run() == {"insert": 0, "update": 0, "merge": 0}
    assert fc2.detail_calls == []                                 # no wasted detail calls
    conn = store.connect(db)
    assert len(store.all_activities(conn)) == 2                   # no duplicates
    conn.close()


def test_login_materializes_token_blob(tmp_path, monkeypatch):
    captured = {}

    class FakeGarmin:
        def login(self, tokdir):
            captured["dir"] = tokdir
            with open(os.path.join(tokdir, "garmin_tokens.json")) as fh:
                captured["blob"] = fh.read()

    fake_mod = types.ModuleType("garminconnect")
    fake_mod.Garmin = lambda *a, **k: FakeGarmin()
    monkeypatch.setitem(sys.modules, "garminconnect", fake_mod)
    monkeypatch.setenv("GARMIN_TOKEN", '{"di_token": "abc"}')
    monkeypatch.delenv("GARMINTOKENS", raising=False)

    f = gf.GarminFetcher(str(tmp_path / "db.sqlite"))
    f._login()
    assert captured["blob"] == '{"di_token": "abc"}'
    assert captured["dir"] == f._tmpdir


class FailingDetailClient(FakeClient):
    def get_activity_details(self, activity_id, maxchart, maxpoly):
        raise RuntimeError("boom")


def test_detail_failure_is_not_persisted_and_retried(tmp_path):
    import warnings

    db = str(tmp_path / "db.sqlite")
    # Run 1: outdoor detail fails -> outdoor skipped, only the indoor gym stored.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        f = gf.GarminFetcher(db, delay_s=0, client=FailingDetailClient(_list(), _detail()))
        assert f.run() == {"insert": 1, "update": 0, "merge": 0}
    conn = store.connect(db)
    assert store.find_by_service_id(conn, "garmin", "5000001") is None      # outdoor not stored
    assert store.find_by_service_id(conn, "garmin", "5000002") is not None  # indoor stored
    conn.close()

    # Run 2: detail works -> the outdoor activity (newer than the gym) is now fetched + stored with geometry.
    f2 = gf.GarminFetcher(db, delay_s=0, client=FakeClient(_list(), _detail()))
    assert f2.run() == {"insert": 1, "update": 0, "merge": 0}
    conn = store.connect(db)
    row = store.find_by_service_id(conn, "garmin", "5000001")
    assert row is not None and row.polyline != ""
    conn.close()


def test_login_rejected_token_exits_3(tmp_path, monkeypatch):
    class FakeGarmin:
        def login(self, tokdir):
            raise Exception("401 unauthorized")

    fake_mod = types.ModuleType("garminconnect")
    fake_mod.Garmin = lambda *a, **k: FakeGarmin()
    monkeypatch.setitem(sys.modules, "garminconnect", fake_mod)
    monkeypatch.setenv("GARMIN_TOKEN", '{"di_token": "x"}')
    monkeypatch.delenv("GARMINTOKENS", raising=False)
    f = gf.GarminFetcher(str(tmp_path / "db.sqlite"))
    with pytest.raises(SystemExit) as exc:
        f._login()
    assert exc.value.code == 3
