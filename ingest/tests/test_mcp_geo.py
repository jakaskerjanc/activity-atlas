import math
import sqlite3

import pytest

from ingest.mcp_server import geo
from ingest.mcp_server.database import Database
from ingest.mcp_server.filters import ActivityFilter
from ingest.mcp_server.geo import MAX_RADIUS_M, activities_near, closest_approach, haversine_m
from ingest.tests.mcp_fixture import build_fixture_db
from ingest.tests.place_fixture import JES_HIKE_LENGTH_M, JES_HIKE_START, M_PER_DEG_LAT, build_place_db


@pytest.fixture
def db(tmp_path):
    d = Database(build_fixture_db(str(tmp_path / "f.sqlite")))
    yield d
    d.close()


@pytest.fixture
def pdb(tmp_path):
    """The MCP fixture plus the place activities, written before Database builds its text table."""
    d = Database(build_place_db(str(tmp_path / "f.sqlite")))
    yield d
    d.close()


def ids_of(r):
    return [row["id"] for row in r["data"]["rows"]]


def test_haversine_one_degree_latitude():
    assert abs(haversine_m(46.0, 14.0, 47.0, 14.0) - 111195) < 10


def test_closest_approach_skips_holes():
    assert closest_approach([46.0, None, 46.001], [14.0, None, 14.0], 46.001, 14.0)[1] == 2


def test_closest_approach_no_points():
    assert closest_approach([None], [None], 46.0, 14.0) is None


def test_triglav_like(db):
    r = activities_near(db, 46.3783, 13.8369)
    assert ids_of(r) == ["hike1"]
    row = r["data"]["rows"][0]
    assert row["closest_m"] <= 20 and row["source"] == "stream"
    assert row["at_elapsed_s"] == 7200 and row["at_local_time"] == "04:12"


def test_radius_edge(db):  # 150 m east of run1's line: in at 200 m, out at 100 m
    lat = 46.05
    lon = 14.0 + 150 / (111320 * math.cos(math.radians(lat)))
    assert "run1" in ids_of(activities_near(db, lat, lon, 200))
    assert "run1" not in ids_of(activities_near(db, lat, lon, 100))


def test_start_mode(db):
    assert ids_of(activities_near(db, 46.0, 14.0, 50, mode="start")) == ["run1"]
    assert ids_of(activities_near(db, 46.09, 14.0, 50, mode="start")) == []


def test_end_mode(db):
    assert ids_of(activities_near(db, 46.09, 14.0, 50, mode="end")) == ["run1"]


def test_filters_apply(db):
    assert ids_of(activities_near(db, 46.3783, 13.8369, f=ActivityFilter(types=["Run"]))) == []


def test_polyline_fallback(db):
    db.conn.close()
    w = sqlite3.connect(db.path)
    w.execute("DELETE FROM streams WHERE file_sha256 = 'sha-hike1'")
    w.commit()
    w.close()
    db.reopen()
    row = activities_near(db, 46.3783, 13.8369)["data"]["rows"][0]
    assert row["source"] == "polyline" and row["closest_m"] <= 20 and row["at_elapsed_s"] is None


def test_rules_state_radius(db):
    assert "within 200 m of 46.3783, 13.8369 (anywhere on the route)" in \
        activities_near(db, 46.3783, 13.8369)["counted"]["rules"]


def test_radius_cap(db):
    with pytest.raises(ValueError):
        activities_near(db, 46.0, 14.0, 60000)


def test_bad_mode(db):
    with pytest.raises(ValueError):
        activities_near(db, 46.0, 14.0, mode="middle")


HIKES = ActivityFilter(types=["Hike"])


def test_nothing_inside_reports_nearest(pdb):
    r = activities_near(pdb, 46.432, 14.062, 3000, "route", ActivityFilter(types=["Hike"], date_to="2025-05-31"))
    assert r["data"]["total"] == 0 and r["data"]["nearest"]["id"] == "far_hike"
    assert 11500 < r["data"]["nearest"]["closest_m"] < 12500
    assert any(x.startswith("nearest outside the radius: 1") for x in r["counted"]["rules"])
    assert set(r["data"]["nearest"]) == {"id", "date_local", "type", "name", "closest_m"}


def test_nearest_is_none_when_something_is_inside(pdb):
    r = activities_near(pdb, 46.432, 14.062, 3000, "route", HIKES)
    assert ids_of(r) == ["jes_hike"] and r["data"]["nearest"] is None
    assert not any(x.startswith("nearest") for x in r["counted"]["rules"])


def test_nearest_none_beyond_50_km(pdb):  # the Adriatic off Pula, over 50 km from every track
    r = activities_near(pdb, 44.8, 13.5, 3000)
    assert r["data"]["total"] == 0 and r["data"]["nearest"] is None
    assert not any(x.startswith("nearest") for x in r["counted"]["rules"])


def test_no_second_pass_at_the_maximum_radius(pdb, monkeypatch):
    """At MAX_RADIUS_M a nearest pass would repeat the first exactly, so it doesn't run."""
    passes = []
    hits = geo._hits
    monkeypatch.setattr(geo, "_hits", lambda *a: passes.append(a[3]) or hits(*a))
    r = activities_near(pdb, 44.8, 13.5, MAX_RADIUS_M)
    assert r["data"]["total"] == 0 and r["data"]["nearest"] is None and passes == [MAX_RADIUS_M]
    activities_near(pdb, 44.8, 13.5, 3000)
    assert passes == [MAX_RADIUS_M, 3000, MAX_RADIUS_M]


def test_nearest_uses_the_mode(pdb):
    """At jes_hike's top its route is inside 200 m; by start point it is about 2.3 km away, and at its
    start, by end point, the same."""
    top = (JES_HIKE_START[0] + JES_HIKE_LENGTH_M / M_PER_DEG_LAT, JES_HIKE_START[1])
    assert ids_of(activities_near(pdb, *top, 200, "route", HIKES)) == ["jes_hike"]
    for mode, point in (("start", top), ("end", JES_HIKE_START)):
        r = activities_near(pdb, *point, 200, mode, HIKES)
        assert r["data"]["total"] == 0 and r["data"]["nearest"]["id"] == "jes_hike", mode
        assert 2200 < r["data"]["nearest"]["closest_m"] < 2400, mode
