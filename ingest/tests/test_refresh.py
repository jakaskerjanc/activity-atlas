import hashlib
import os
import subprocess
import sys

import pytest

from ingest import db, grouping, naming
from ingest import refresh as refresh_mod
from ingest.refresh import refresh, refresh_file
from ingest.tests.test_grouping import A, N, _hike, _loop_from, _t
from ingest.tests.track_fixture import climb_alts, insert_activity, offset

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
B = offset([A], 600, 0)[0]          # a second top, 600 m east of A


def sha256(path) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _osm(conn, osm_id, kind, name, at, ele=None):
    conn.execute("INSERT INTO osm_points (osm_id, kind, name, lat, lon, ele, country) VALUES (?,?,?,?,?,?, 'SI')",
                 (osm_id, kind, name, at[0], at[1], ele))


def _fill(conn):
    """Three hikes to A (two named "Slavnik"), a hike to B, and two flat runs on one loop."""
    insert_activity(conn, "h1", "Hike", _t(1), _hike(A, 0), alts=climb_alts(N, 300), name="Slavnik summit")
    insert_activity(conn, "h2", "Hike", _t(2), _hike(A, 120), alts=climb_alts(N, 300), name="Slavnik with Teja")
    insert_activity(conn, "h3", "Hike", _t(3), _hike(A, 240), alts=climb_alts(N, 300), name="Morning Hike")
    insert_activity(conn, "b1", "Hike", _t(4), _hike(B, 180), alts=climb_alts(N, 300), name="Morning Hike")
    insert_activity(conn, "r1", "Run", _t(5), _loop_from(offset([A], 0, -5000)[0]), alts=climb_alts(N, 10))
    insert_activity(conn, "r2", "Run", _t(6), _loop_from(offset([A], 20, -5000)[0]), alts=climb_alts(N, 10))
    _osm(conn, "node/1", "peak", "Slavnik", offset([A], 30, 0)[0], 1028.0)
    _osm(conn, "node/2", "village", "Podgorje", offset([A], 0, -9000)[0])


def build_db(tmp_path) -> str:
    path = str(tmp_path / "a.sqlite")
    conn = db.open_db(path)
    _fill(conn)
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    db.init_schema(c)
    _fill(c)
    c.commit()
    yield c
    c.close()


def _rows(conn, table):
    return {r[0]: tuple(r[1:]) for r in conn.execute(f"SELECT * FROM {table}")}


def _override(conn, kind, group_id, name=None, merge_into=None):
    conn.execute("INSERT INTO group_overrides (kind, group_id, name, merge_into) VALUES (?,?,?,?)",
                 (kind, group_id, name, merge_into))


@pytest.mark.parametrize("mod", ["osm", "naming", "grouping", "refresh", "writer", "rebuild"])
def test_each_module_imports_first(mod):
    subprocess.run([sys.executable, "-c", f"import ingest.{mod}"], check=True, cwd=REPO)  # no import cycle


def test_refresh_fills_tables(conn):
    _override(conn, "route", "r1", name="Track loop")
    result = refresh(conn)

    tracks = grouping.load_tracks(conn)
    groups = grouping.group_activities(tracks)
    index = naming.PointIndex([naming.OsmPoint("node/1", "peak", "Slavnik", *offset([A], 30, 0)[0], 1028.0),
                               naming.OsmPoint("node/2", "village", "Podgorje", *offset([A], 0, -9000)[0], None)])
    places = naming.name_places(groups, tracks, index, {})
    routes = naming.name_routes(groups, tracks, places, index, {"r1": "Track loop"})
    assert _rows(conn, "places") == {p.id: (p.name, p.name_source, p.kind, p.ele) for p in places.values()}
    assert _rows(conn, "route_groups") == {r.id: (r.name, r.name_source) for r in routes.values()}
    assert _rows(conn, "activity_groups") == {
        "h1": ("h1", None), "h2": ("h1", None), "h3": ("h1", None), "b1": ("b1", None),
        "r1": (None, "r1"), "r2": (None, "r1")}
    assert _rows(conn, "places")["h1"] == ("Slavnik", "activity_names", "peak", 1028.0)
    assert _rows(conn, "route_groups") == {"r1": ("Track loop", "owner")}
    assert result == {"places": 2, "routes": 1, "rows_changed": 9, "no_osm_nearby": 0, "orphaned_overrides": []}


def test_refresh_updates_only_rows_that_differ(conn):
    refresh(conn)
    conn.commit()
    _override(conn, "place", "b1", name="Grmada")
    conn.execute("UPDATE activities SET visible = 0 WHERE id = 'r2'")
    result = refresh(conn)
    # b1 renamed; route r1 is down to one activity, so it and both runs' activity_groups rows go
    assert result["rows_changed"] == 4 and result["routes"] == 0
    assert set(_rows(conn, "activity_groups")) == {"h1", "h2", "h3", "b1"}
    assert _rows(conn, "places")["b1"][:2] == ("Grmada", "owner")


def test_second_refresh_changes_nothing(tmp_path):
    path = build_db(tmp_path)
    assert refresh_file(path)["rows_changed"] > 0
    before = sha256(path)
    assert refresh_file(path)["rows_changed"] == 0 and sha256(path) == before


def test_hiding_the_anchor_reanchors_and_reports_orphaned_name(conn):
    _override(conn, "place", "h1", name="Moj hrib")
    assert _rows(conn, "places") == {}
    refresh(conn)
    assert _rows(conn, "places")["h1"][:2] == ("Moj hrib", "owner")
    conn.execute("UPDATE activities SET visible = 0 WHERE id = 'h1'")
    result = refresh(conn)
    assert result["orphaned_overrides"] == ["place h1"]
    places = _rows(conn, "places")
    assert "h1" not in places and places["h2"][1] != "owner"
    assert _rows(conn, "activity_groups")["h3"] == ("h2", None)


def test_merged_away_place_is_not_orphaned(conn):
    _override(conn, "place", "b1", merge_into="h1")
    result = refresh(conn)
    assert result["orphaned_overrides"] == [] and result["places"] == 1
    assert "b1" not in _rows(conn, "places")
    assert _rows(conn, "activity_groups")["b1"] == ("h1", None)


def test_merge_into_missing_target_is_orphaned(conn):
    _override(conn, "place", "b1", merge_into="h1")
    conn.execute("UPDATE activities SET visible = 0 WHERE id IN ('h1', 'h2', 'h3')")
    result = refresh(conn)
    assert result["orphaned_overrides"] == ["place b1"]
    assert set(_rows(conn, "places")) == {"b1"}


def test_route_name_without_a_route_is_orphaned(conn):
    _override(conn, "route", "h1", name="Not a route")
    assert refresh(conn)["orphaned_overrides"] == ["route h1"]


def test_refresh_error_leaves_file_unchanged(tmp_path, monkeypatch):
    path = build_db(tmp_path)
    refresh_file(path)
    c = db.connect(path)
    insert_activity(c, "h4", "Hike", _t(7), _hike(B, 0), alts=climb_alts(N, 300))
    c.execute("DELETE FROM places WHERE id = 'b1'")
    c.commit()
    c.close()
    before = sha256(path)

    def boom(*a, **kw):
        raise RuntimeError("naming broke")
    monkeypatch.setattr(naming, "name_routes", boom)
    with pytest.raises(RuntimeError, match="naming broke"):
        refresh_file(path)
    assert sha256(path) == before
    assert not os.path.exists(path + "-journal")


def test_refresh_error_after_a_write_rolls_back(tmp_path, monkeypatch):
    path = build_db(tmp_path)
    before = sha256(path)
    real = refresh_mod._sync
    calls = []

    def fail_second(*a, **kw):     # the places table is written, then the route_groups write fails
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("disk said no")
        return real(*a, **kw)
    monkeypatch.setattr(refresh_mod, "_sync", fail_second)
    with pytest.raises(RuntimeError, match="disk said no"):
        refresh_file(path)
    assert sha256(path) == before


def test_refresh_skips_v4_and_missing(tmp_path):
    missing = str(tmp_path / "none.sqlite")
    assert refresh_file(missing) is None and not os.path.exists(missing)

    v4 = build_db(tmp_path)
    c = db.connect(v4)
    c.execute("PRAGMA user_version = 4")
    c.commit()
    c.close()
    before = sha256(v4)
    assert refresh_file(v4) is None and sha256(v4) == before

    empty = str(tmp_path / "empty.sqlite")
    db.open_db(empty).close()
    before = sha256(empty)
    assert refresh_file(empty) == {"places": 0, "routes": 0, "rows_changed": 0, "no_osm_nearby": 0,
                                   "orphaned_overrides": []}
    assert sha256(empty) == before


def test_no_osm_warning_only_with_osm_data(tmp_path, capsys):
    path = build_db(tmp_path)
    c = db.connect(path)
    c.execute("DELETE FROM osm_points")
    c.commit()
    c.close()
    assert refresh_file(path)["no_osm_nearby"] == 2
    assert "no OSM data nearby" not in capsys.readouterr().out

    c = db.connect(path)
    _osm(c, "node/9", "peak", "Far away", offset([B], 9800, 0)[0], 900.0)   # within 10 km of B only
    c.commit()
    c.close()
    assert refresh_file(path)["no_osm_nearby"] == 1
    assert "1 places have no OSM data nearby; run pnpm run places:update" in capsys.readouterr().out


def test_orphans_are_printed_with_the_command_that_clears_them(tmp_path):
    path = build_db(tmp_path)
    c = db.connect(path)
    _override(c, "place", "gone", name="Old name", merge_into="h1")
    _override(c, "place", "b1", merge_into="missing")
    _override(c, "route", "h2", name="Old route")
    c.commit()
    c.close()
    lines = []
    assert refresh_file(path, log=lines.append)["orphaned_overrides"] == ["place b1", "place gone", "route h2"]
    assert len(lines) == 3
    assert 'unmerge-place b1' in lines[0]
    assert 'name-place gone ""' in lines[1] and "unmerge-place gone" in lines[1]
    assert 'name-route h2 ""' in lines[2]
