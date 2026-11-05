import math

import pytest

from ingest.mcp_server.database import Database
from ingest.mcp_server.filters import ActivityFilter
from ingest.mcp_server.geo import activities_near, closest_approach, haversine_m
from ingest.tests.mcp_fixture import build_fixture_db


@pytest.fixture
def db(tmp_path):
    d = Database(build_fixture_db(str(tmp_path / "f.sqlite")))
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
    import sqlite3
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
