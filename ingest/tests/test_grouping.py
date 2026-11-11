import math

import pytest

from ingest import db
from ingest.geometry import discrete_frechet, haversine_m, project, resample
from ingest.grouping import (ROUTE_MAX_FRECHET_M, ROUTE_POINTS, ActivityTrack, Groups, _same_route,
                             group_activities, load_tracks)
from ingest.tests.track_fixture import climb_alts, insert_activity, line, loop, offset

A = (45.6, 14.0)
N = 301
R = 3000 / (2 * math.pi)  # a 3 km loop


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    db.init_schema(c)
    yield c
    c.close()


def _t(day: int) -> str:
    return f"2025-06-{day:02d}T07:00:00+00:00"


def _hike(top, approach_deg: float):
    """A 3 km loop whose far side (the climb's midpoint) is ``top``, starting 2R away in ``approach_deg``."""
    a = math.radians(approach_deg)
    center = offset([top], R * math.sin(a), R * math.cos(a))[0]
    return loop(center, R, N, start_deg=approach_deg)


def _loop_from(start, *, along: float = R, across: float = R):
    """A loop starting at ``start``, reaching ``2 * along`` north and ``across`` to each side."""
    pts = []
    for i in range(N):
        t = 2 * math.pi * i / (N - 1)
        pts.append(offset([start], across * math.sin(t), along - along * math.cos(t))[0])
    return pts


def _groups(conn, merges=None) -> Groups:
    return group_activities(load_tracks(conn), merges or {})


# --- load_tracks -----------------------------------------------------------------------------------------------

def test_load_tracks_reads_visible_tracks_in_order(conn):
    insert_activity(conn, "b", "Hike", _t(2), _hike(A, 0), alts=climb_alts(N, 300), name="Hike B")
    insert_activity(conn, "a", "Hike", _t(2), _hike(A, 90), alts=climb_alts(N, 300))
    insert_activity(conn, "early", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "hidden", "Run", _t(3), _loop_from(A), visible=0)
    insert_activity(conn, "dot", "Run", _t(4), [A])
    conn.execute("INSERT INTO activities (id, name, type, start_time, visible) VALUES ('nogps', 'x', 'Run', ?, 1)",
                 (_t(5),))
    tracks = load_tracks(conn)
    assert [t.id for t in tracks] == ["early", "a", "b"]
    b = tracks[2]
    assert isinstance(b, ActivityTrack)
    assert b.type == "Hike" and b.name == "Hike B" and b.start_local == "2025-06-02T08:00:00"
    assert len(b.line) == N and abs(b.line[0][0] - _hike(A, 0)[0][0]) < 1e-5
    assert b.top is not None and haversine_m(b.top.lat, b.top.lon, *A) < 20 and b.top.climb > 200
    assert tracks[0].top is None  # no altitude channel


def test_missing_streams_row_loads_without_top_and_still_joins_a_route(conn):
    insert_activity(conn, "r1", "Run", _t(1), _loop_from(A), alts=climb_alts(N, 300))
    insert_activity(conn, "r2", "Run", _t(2), _loop_from(A), alts=climb_alts(N, 300))
    conn.execute("DELETE FROM streams WHERE file_sha256 = 'sha-r2'")
    tracks = load_tracks(conn)
    assert [t.top is None for t in tracks] == [False, True]
    g = group_activities(tracks)
    assert "r2" not in g.place_of
    assert g.route_of == {"r1": "r1", "r2": "r1"}


def test_altitude_holes_are_skipped(conn):
    alts = climb_alts(N, 300)
    for i in range(0, N, 7):
        alts[i] = None
    insert_activity(conn, "h", "Hike", _t(1), _hike(A, 0), alts=alts)
    insert_activity(conn, "allnone", "Hike", _t(2), _hike(A, 90), alts=[None] * N)
    tracks = load_tracks(conn)
    top = tracks[0].top
    assert top is not None and haversine_m(top.lat, top.lon, *A) < 20 and top.climb > 200
    assert tracks[1].top is None
    assert _groups(conn).place_of == {"h": "h"}


# --- places ----------------------------------------------------------------------------------------------------

def test_hikes_to_same_top_share_a_place(conn):
    insert_activity(conn, "h1", "Hike", _t(1), _hike(A, 0), alts=climb_alts(N, 300))
    insert_activity(conn, "h2", "Hike", _t(2), _hike(offset([A], 100, 50)[0], 120), alts=climb_alts(N, 300))
    insert_activity(conn, "h3", "Hike", _t(3), _hike(offset([A], -80, -120)[0], 240), alts=climb_alts(N, 300))
    g = _groups(conn)
    assert g.place_of == {"h1": "h1", "h2": "h1", "h3": "h1"}
    assert g.place_anchors == frozenset({"h1"})


def test_tops_600_m_apart_are_two_places(conn):
    insert_activity(conn, "h1", "Hike", _t(1), _hike(A, 0), alts=climb_alts(N, 300))
    insert_activity(conn, "h2", "Hike", _t(2), _hike(offset([A], 600, 0)[0], 0), alts=climb_alts(N, 300))
    assert _groups(conn).place_of == {"h1": "h1", "h2": "h2"}


def test_place_anchoring_does_not_chain(conn):
    insert_activity(conn, "a", "Hike", _t(1), _hike(A, 180), alts=climb_alts(N, 300))
    insert_activity(conn, "b", "Hike", _t(2), _hike(offset([A], 400, 0)[0], 180), alts=climb_alts(N, 300))
    insert_activity(conn, "c", "Hike", _t(3), _hike(offset([A], 800, 0)[0], 180), alts=climb_alts(N, 300))
    g = _groups(conn)
    assert g.place_of == {"a": "a", "b": "a", "c": "c"}


def test_flat_run_has_no_place(conn):
    insert_activity(conn, "flat", "Run", _t(1), _hike(A, 0), alts=climb_alts(N, 20))
    assert "flat" not in _groups(conn).place_of


def test_activity_without_altitude_gets_route_but_no_place(conn):
    insert_activity(conn, "r1", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "r2", "Run", _t(2), offset(_loop_from(A), 20, 0))
    g = _groups(conn)
    assert g.place_of == {}
    assert g.route_of == {"r1": "r1", "r2": "r1"}


def test_place_spans_types(conn):
    insert_activity(conn, "ride", "Ride", _t(1), _hike(A, 0), alts=climb_alts(N, 300))
    insert_activity(conn, "hike", "Hike", _t(2), _hike(offset([A], 50, 50)[0], 200), alts=climb_alts(N, 300))
    assert _groups(conn).place_of == {"ride": "ride", "hike": "ride"}


def test_merge_moves_activities_and_follows_chains(conn):
    for i, east in enumerate((0, 600, 1200)):
        insert_activity(conn, "abc"[i], "Hike", _t(i + 1), _hike(offset([A], east, 0)[0], 180),
                        alts=climb_alts(N, 300))
    assert _groups(conn).place_of == {"a": "a", "b": "b", "c": "c"}
    assert _groups(conn, {"b": "a", "c": "b"}).place_of == {"a": "a", "b": "a", "c": "a"}
    assert _groups(conn, {"b": "gone"}).place_of == {"a": "a", "b": "b", "c": "c"}
    assert _groups(conn, {"c": "b", "b": "gone"}).place_of == {"a": "a", "b": "b", "c": "b"}


def test_place_anchors_keep_merged_away_places(conn):
    insert_activity(conn, "a", "Hike", _t(1), _hike(A, 180), alts=climb_alts(N, 300))
    insert_activity(conn, "b", "Hike", _t(2), _hike(offset([A], 600, 0)[0], 180), alts=climb_alts(N, 300))
    g = _groups(conn, {"b": "a"})
    assert g.place_anchors == frozenset({"a", "b"})
    assert "b" not in g.place_of.values()


def test_hidden_anchor_hands_the_place_to_the_next_activity(conn):
    insert_activity(conn, "h1", "Hike", _t(1), _hike(A, 0), alts=climb_alts(N, 300), visible=0)
    insert_activity(conn, "h2", "Hike", _t(2), _hike(A, 120), alts=climb_alts(N, 300))
    insert_activity(conn, "h3", "Hike", _t(3), _hike(A, 240), alts=climb_alts(N, 300))
    g = _groups(conn)
    assert g.place_of == {"h2": "h2", "h3": "h2"}
    assert g.place_anchors == frozenset({"h2"})


# --- routes ----------------------------------------------------------------------------------------------------

def test_same_loop_either_direction_is_one_route(conn):
    insert_activity(conn, "fwd", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "rev", "Run", _t(2), offset(_loop_from(A)[::-1], 20, 0))
    assert _groups(conn).route_of == {"fwd": "fwd", "rev": "fwd"}


def test_different_loop_from_same_start_is_another_route(conn):
    insert_activity(conn, "round", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "round2", "Run", _t(2), _loop_from(A))
    # Same start and about the same length, but the far side lies 400 m beyond the first loop's.
    insert_activity(conn, "long", "Run", _t(3), _loop_from(A, along=R + 200, across=240))
    insert_activity(conn, "long2", "Run", _t(4), _loop_from(A, along=R + 200, across=240))
    assert _groups(conn).route_of == {"round": "round", "round2": "round", "long": "long", "long2": "long"}


def test_route_needs_same_type(conn):
    insert_activity(conn, "run", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "walk", "Walk", _t(2), _loop_from(A))
    assert _groups(conn).route_of == {}


def test_route_needs_distance_within_15_percent(conn):
    insert_activity(conn, "a", "Run", _t(1), _loop_from(A), distance=3000)
    insert_activity(conn, "b", "Run", _t(2), _loop_from(A), distance=3600)
    assert _groups(conn).route_of == {}
    conn.execute("UPDATE activities SET distance = 3500 WHERE id = 'b'")
    assert _groups(conn).route_of == {"a": "a", "b": "a"}


def test_singletons_have_no_route(conn):
    insert_activity(conn, "a", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "b", "Run", _t(2), _loop_from(offset([A], 5000, 0)[0]))
    assert _groups(conn).route_of == {}


def test_route_ids_are_anchor_ids_and_stable_when_newer_added(conn):
    insert_activity(conn, "r1", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "r2", "Run", _t(2), offset(_loop_from(A), 30, 0))
    assert _groups(conn).route_of == {"r1": "r1", "r2": "r1"}
    insert_activity(conn, "r3", "Run", _t(3), offset(_loop_from(A)[::-1], -30, 10))
    assert _groups(conn).route_of == {"r1": "r1", "r2": "r1", "r3": "r1"}


def test_missing_distance_skips_route_grouping(conn):
    insert_activity(conn, "a", "Run", _t(1), _loop_from(A))
    insert_activity(conn, "b", "Run", _t(2), _loop_from(A))
    insert_activity(conn, "c", "Run", _t(3), _loop_from(A))
    conn.execute("UPDATE activities SET distance = NULL WHERE id IN ('a', 'b')")
    assert _groups(conn).route_of == {}


def test_grouping_sorts_its_input():
    line = ((45.6, 14.0), (45.61, 14.0))
    early = ActivityTrack("z", "Run", "2025-01-01T07:00:00+00:00", None, "", 1100.0, line, None)
    late = ActivityTrack("a", "Run", "2025-01-02T07:00:00+00:00", None, "", 1100.0, line, None)
    assert group_activities([late, early]).route_of == {"z": "z", "a": "z"}


def _track(id_: str, pts) -> ActivityTrack:
    length = sum(haversine_m(*a, *b) for a, b in zip(pts, pts[1:]))
    return ActivityTrack(id_, "Run", "2025-01-01T07:00:00+00:00", None, "", length, tuple(pts), None)


def test_same_route_is_the_frechet_rule_either_way_round():
    """_same_route answers as min(discrete_frechet forward, reversed) < 250 m after the distance and start
    checks, for loops, reversed loops and lines started from either end, near the 250 m limit too."""
    tracks = [_track("loop", _loop_from(A)), _track("loop_rev", _loop_from(A)[::-1])]
    for east in (0, 120, 240, 249.5, 250.5, 260, 400, 900):
        tracks.append(_track(f"loop+{east}", offset(_loop_from(A), east, 0)))
        tracks.append(_track(f"loop_rev+{east}", offset(_loop_from(A)[::-1], east, 0)))
        out = line(offset([A], east, 0)[0], 10, 3000, 200)
        tracks.append(_track(f"line+{east}", out))
        tracks.append(_track(f"line_rev+{east}", out[::-1]))   # starts near the far end of "line+0"
    tracks.append(_track("wide", _loop_from(A, along=R + 200, across=240)))
    answers = set()
    for anchor in tracks:
        anchor_xy = resample(project(anchor.line, anchor.line[0]), ROUTE_POINTS)
        for t in tracks:
            a, b = anchor.distance, t.distance
            start = t.line[0]
            near = min(haversine_m(*start, *anchor.line[0]), haversine_m(*start, *anchor.line[-1])) <= 1000
            if abs(a - b) > 0.15 * max(a, b) or not near:
                expected = False
            else:
                xy = resample(project(t.line, anchor.line[0]), ROUTE_POINTS)
                expected = min(discrete_frechet(anchor_xy, xy), discrete_frechet(anchor_xy, xy[::-1])) \
                    < ROUTE_MAX_FRECHET_M
            assert _same_route(anchor, anchor_xy, t) == expected, (anchor.id, t.id)
            answers.add((near, expected))
    assert answers == {(True, True), (True, False), (False, False)}
