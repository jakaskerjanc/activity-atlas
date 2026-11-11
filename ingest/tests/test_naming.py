import math
from collections import Counter

from ingest.geometry import Top, haversine_m
from ingest.grouping import ActivityTrack, Groups
from ingest.naming import (OsmPoint, PlaceInfo, PointIndex, is_default_name, name_places, name_point, name_routes,
                           name_words)
from ingest.tests.track_fixture import offset, out_and_back

O = (46.07, 14.48)  # Ljubljana
EMPTY = PointIndex([])
MAY_3 = "2024-05-03T07:00:00+00:00"


def _ll(x: float, y: float) -> tuple[float, float]:
    """(lat, lon) of a point x metres east and y metres north of O."""
    return offset([O], x, y)[0]


def _path(waypoints, step: float = 25.0) -> tuple[tuple[float, float], ...]:
    """A dense (lat, lon) polyline through waypoints given in metres around O."""
    pts = [waypoints[0]]
    for (x0, y0), (x1, y1) in zip(waypoints, waypoints[1:]):
        n = max(1, math.ceil(math.dist((x0, y0), (x1, y1)) / step))
        pts += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(1, n + 1)]
    return tuple(_ll(x, y) for x, y in pts)


def _osm(osm_id: str, kind: str, name: str, x: float, y: float, ele: float | None = None) -> OsmPoint:
    lat, lon = _ll(x, y)
    return OsmPoint(osm_id, kind, name, lat, lon, ele)


def _track(id_, line, *, type_="Run", start=MAY_3, start_local=None, name="", distance=None, top=None):
    if distance is None:
        distance = sum(haversine_m(*a, *b) for a, b in zip(line, line[1:]))
    return ActivityTrack(id=id_, type=type_, start_time=start, start_local=start_local, name=name,
                         distance=distance, line=tuple(line), top=top)


# --- default names and words ----------------------------------------------------------------------------------

def test_default_names():
    assert is_default_name("☀️ Morning Hike") and is_default_name("Ljubljana Walking") \
        and not is_default_name("Slavnik summit attempt")
    assert is_default_name("Lunch Run") and is_default_name("Hrpelje-Kozina Trail Running")
    assert not is_default_name("Walking") and not is_default_name("Morning hike na Šmarno")


def test_name_words_drops_generic_and_short_words():
    assert name_words("Velika planina s Tejo") == ["velika", "planina", "tejo"]
    assert name_words("Easy run to the Hill") == []
    assert name_words("Pohod na Šmarno goro") == ["šmarno", "goro"]
    # direction and effort words from the demo's route names are not places
    assert name_words("Tempo run - Out to Kamnica") == ["kamnica"]
    assert name_words("Morning hike - Forest above Ruše") == ["ruše"]
    assert name_words("Climb to Areh, flat laps and back below") == ["areh"]


# --- places ---------------------------------------------------------------------------------------------------

def _name_place(names, osm=(), *, top_ele=1068.0, owner=None) -> PlaceInfo:
    """One place, anchored at its first activity, whose activities all top out at O."""
    top = Top(O[0], O[1], top_ele, 300.0)
    tracks = [_track(f"a{i}", _path([(0, -2000), (0, 0)]), type_="Hike",
                     start=f"2024-05-{i + 1:02d}T07:00:00+00:00", name=n, top=top)
              for i, n in enumerate(names)]
    groups = Groups(place_of={t.id: "a0" for t in tracks}, route_of={}, place_anchors=frozenset({"a0"}))
    places = name_places(groups, tracks, PointIndex(osm), owner or {})
    assert list(places) == ["a0"]
    return places["a0"]


def test_place_from_repeated_words_uses_osm_spelling():
    p = _name_place(["Šmarna z Mojco", "Jutranja Šmarna"], [_osm("n1", "peak", "Šmarna gora", 40, 0, 669)])
    assert (p.name, p.name_source) == ("Šmarna gora", "activity_names")


def test_case_endings_are_not_a_repeat():
    p = _name_place(["Na Šmarno", "Šmarna z Mojco"], [_osm("n1", "peak", "Šmarna gora", 40, 0, 669)])
    assert (p.name, p.name_source) == ("Šmarna gora", "osm")


def test_place_name_keeps_activity_spelling():
    p = _name_place(["Velika planina", "Velika planina s Tejo"], [_osm("n1", "peak", "Gradišče", 200, 0, 1666)])
    assert (p.name, p.name_source) == ("Velika planina", "activity_names")
    assert (p.kind, p.ele) == ("peak", 1666)


def test_bigram_needs_adjacent_kept_words():
    # "Planina s Tejo" has no "planina tejo" bigram: the dropped "s" sits between them.
    p = _name_place(["Planina s Tejo", "Planina Tejo zjutraj"])
    assert (p.name, p.name_source) == ("Planina", "activity_names")


def test_place_phrase_spelled_as_in_earliest_name():
    p = _name_place(["VELIKA planina", "velika Planina s Tejo", "Velika planina"])
    assert (p.name, p.name_source) == ("VELIKA planina", "activity_names")


def test_osm_spelling_needs_a_whole_word_prefix():
    p = _name_place(["Sla hike", "Sla zjutraj"], [_osm("n1", "peak", "Slavnik", 40, 0, 1028)])
    assert (p.name, p.name_source) == ("Sla", "activity_names")


def test_place_ignores_default_town_names():
    p = _name_place(["Ljubljana Walking"] * 4, [_osm("n1", "peak", "Šišenski hrib", 60, 0, 429)])
    assert (p.name, p.name_source) == ("Šišenski hrib", "osm")


def test_effort_words_never_name_a_place():
    p = _name_place(["Easy run", "Weekend ride", "Hill ride", "Tempo run"])
    assert (p.name, p.name_source) == ("Top at 1,070 m", "fallback")


def test_single_activity_place_skips_words():
    p = _name_place(["Test Shitbox"], [_osm("n1", "peak", "Peštota", 50, 0, 590)])
    assert (p.name, p.name_source) == ("Peštota", "osm")
    p = _name_place(["Shitbox Shitbox"], [_osm("n1", "peak", "Peštota", 50, 0, 590)])
    assert (p.name, p.name_source) == ("Peštota", "osm")


def test_place_owner_name_wins():
    p = _name_place(["Šmarna z Mojco", "Jutranja Šmarna"], [_osm("n1", "peak", "Šmarna gora", 40, 0, 669)],
                    owner={"a0": "Domači hrib"})
    assert (p.name, p.name_source, p.kind, p.ele) == ("Domači hrib", "owner", "peak", 669)


def test_place_fallback_top_at():
    p = _name_place(["Morning Hike", "Afternoon Hike"], [_osm("n1", "peak", "Daleč", 600, 0, 1100)])
    assert (p.name, p.name_source, p.kind, p.ele) == ("Top at 1,070 m", "fallback", "top", 1070)


def test_place_height_from_osm():
    p = _name_place(["Morning Hike"], [_osm("n1", "peak", "Slavnik", 100, 0, 1028),
                                       _osm("n2", "peak", "Mali Slavnik", 300, 0, 990)])
    assert (p.name, p.kind, p.ele) == ("Slavnik", "peak", 1028)
    p = _name_place(["Morning Hike"], [_osm("n1", "pass", "Vršič", 100, 0, None)])
    assert (p.name, p.kind, p.ele) == ("Vršič", "pass", 1070)


def test_place_uses_its_highest_top():
    low, high = Top(*_ll(0, 0), 900.0, 200.0), Top(*_ll(0, 450), 1068.0, 300.0)
    tracks = [_track("a", _path([(0, -2000), (0, 0)]), top=low), _track("b", _path([(0, -2000), (0, 450)]), top=high)]
    groups = Groups(place_of={"a": "a", "b": "a"}, route_of={}, place_anchors=frozenset({"a"}))
    index = PointIndex([_osm("n1", "peak", "Nizki", 0, -100, 905), _osm("n2", "peak", "Visoki", 0, 550, 1071)])
    p = name_places(groups, tracks, index, {})["a"]
    assert (p.name, p.ele) == ("Visoki", 1071)


# --- naming a point -------------------------------------------------------------------------------------------

def test_point_index_near_sorts_by_distance_and_filters_kind():
    index = PointIndex([_osm("a", "peak", "Far", 120, 0), _osm("b", "park", "Park", 10, 0),
                        _osm("c", "peak", "Near", 0, 60), _osm("d", "peak", "Out", 0, 400)])
    hits = index.near(*O, 150, ("peak",))
    assert [p.name for _, p in hits] == ["Near", "Far"]
    assert abs(hits[0][0] - 60) < 1
    assert EMPTY.near(*O, 5000, ("peak",)) == []


def test_point_index_crosses_grid_cells():
    edge = (46.05 - 0.0001, 14.50 - 0.0001)
    across = offset([edge], 100, 100)[0]
    index = PointIndex([OsmPoint("a", "peak", "Across", across[0], across[1], None)])
    assert [p.name for _, p in index.near(*edge, 150, ("peak",))] == ["Across"]


def test_point_name_prefers_peak_then_park_then_neighbourhood():
    points = [_osm("1", "peak", "Rožnik", 120, 0), _osm("2", "park", "Park Tivoli", 50, 0),
              _osm("3", "neighbourhood", "Rožna dolina", 10, 0), _osm("4", "village", "Vas", 5, 0)]
    assert name_point(*O, PointIndex(points)) == "Rožnik"
    assert name_point(*O, PointIndex(points[1:])) == "Park Tivoli"
    assert name_point(*O, PointIndex(points[2:])) == "Rožna dolina"
    assert name_point(*O, PointIndex([_osm("1", "peak", "Rožnik", 160, 0)] + points[2:])) == "Rožna dolina"
    assert name_point(*O, PointIndex([_osm("5", "village", "Vas", 1900, 0)])) == "Vas"
    assert name_point(*O, PointIndex([_osm("5", "village", "Vas", 2100, 0)])) is None
    assert name_point(*O, EMPTY) is None


# --- routes ---------------------------------------------------------------------------------------------------

def _route_names(anchors, index=EMPTY, *, places=None, place_of=None, owner=None) -> dict[str, str]:
    route_of = {}
    for a in anchors:
        route_of[a.id] = route_of[f"{a.id}-2"] = a.id
    groups = Groups(place_of=place_of or {}, route_of=route_of, place_anchors=frozenset())
    routes = name_routes(groups, anchors, places or {}, index, owner or {})
    assert set(routes) == {a.id for a in anchors}
    return {k: r.name for k, r in routes.items()}


def _loop_route(start_x: float, apex_x: float, dx: float = 0.0):
    """A ~6.5 km loop: from (start_x, 0) to (0, 400), north to the turnaround (0, 3000), back by (apex_x, 1500)
    to (0, 400) and the start. ``dx`` shifts the whole route east."""
    pts = [(start_x, 0), (0, 400), (0, 3000), (apex_x, 1500), (0, 400), (start_x, 0)]
    return _path([(x + dx, y) for x, y in pts])


def test_route_with_place_uses_place_name_and_shape():
    hike = _track("h", out_and_back(_ll(0, 0), 0, 4000, 101), type_="Hike")
    places = {"p": PlaceInfo("p", "Slavnik", "osm", "peak", 1028)}
    index = PointIndex([_osm("1", "neighbourhood", "Podgorje", 0, 4000)])
    assert _route_names([hike], index, places=places, place_of={"h": "p", "h-2": "p"}) == {"h": "Slavnik out-and-back"}


def test_route_owner_name_wins():
    run = _track("r", _loop_route(300, 300))
    names = _route_names([run], owner={"r": "Domači krog"})
    assert names == {"r": "Domači krog"}
    groups = Groups(place_of={}, route_of={"r": "r"}, place_anchors=frozenset())
    assert name_routes(groups, [run], {}, EMPTY, {"r": "Domači krog"})["r"].name_source == "owner"
    assert name_routes(groups, [run], {}, EMPTY, {})["r"].name_source == "auto"


def test_flat_loop_named_after_turnaround():
    index = PointIndex([_osm("1", "neighbourhood", "Koseze", 300, 3000), _osm("2", "neighbourhood", "Vrtača", 300, 0)])
    assert _route_names([_track("r", _loop_route(300, 300))], index) == {"r": "Koseze loop"}


def test_flat_loop_without_osm_named_by_distance():
    loop5 = _track("l", _loop_route(300, 300), distance=5200)
    line12 = _track("p", _path([(0, 0), (0, 12000)]), distance=12000)
    assert _route_names([loop5, line12]) == {"l": "5.2 km loop", "p": "12.0 km point-to-point"}


def test_point_to_point_start_to_end():
    index = PointIndex([_osm("1", "neighbourhood", "Rožna dolina", 0, -100),
                        _osm("2", "neighbourhood", "Vrtača", 100, 3000)])
    run = _track("r", _path([(0, 0), (0, 3000)]))
    assert _route_names([run], index) == {"r": "Rožna dolina → Vrtača"}
    index = PointIndex([_osm("1", "neighbourhood", "Vrtača", 250, -100), _osm("2", "neighbourhood", "Brdo", 250, 2100)])
    u_turn = _track("u", _path([(0, 0), (0, 2000), (500, 2000), (500, 0)]))
    assert _route_names([u_turn], index) == {"u": "Brdo loop"}


def test_point_to_point_with_one_named_end_falls_back():
    index = PointIndex([_osm("1", "neighbourhood", "Koseze", 0, -100)])
    run = _track("r", _path([(0, 0), (0, 12000)]), distance=12000)
    assert _route_names([run], index) == {"r": "12.0 km point-to-point"}


def test_collision_via_divergence_ignores_first_500_m():
    index = PointIndex([_osm("1", "neighbourhood", "Novo Brdo", 0, 3100),
                        _osm("2", "park", "Rožnik", 400, 1500), _osm("3", "water", "Ribnik", -400, 1500),
                        # 300 m from each start, where the two routes are farthest apart
                        _osm("4", "neighbourhood", "Vrtača", 400, -300), _osm("5", "neighbourhood", "Mirje", -400, -300)])
    a = _track("a", _loop_route(400, 400))
    b = _track("b", _loop_route(-400, -400), start="2024-06-03T07:00:00+00:00")
    assert _route_names([a, b], index) == {"a": "Novo Brdo loop via Rožnik", "b": "Novo Brdo loop via Ribnik"}


def test_collision_via_feature_only_this_route_passes():
    # The divergence points (the apexes) are unnamed; a peak 50 m off a's return leg is > 150 m from b.
    index = PointIndex([_osm("1", "neighbourhood", "Koseze", 0, 3100),
                        _osm("2", "peak", "Debeli hrib", 200 + 47, 950 + 17)])
    a = _track("a", _loop_route(400, 400), distance=6400)
    b = _track("b", _loop_route(-400, -400), distance=6400, start="2024-06-03T07:00:00+00:00")
    assert _route_names([a, b], index) == {"a": "Koseze loop via Debeli hrib", "b": "Koseze loop, 6.4 km"}


def _switchback_ride(sign: int):
    """A ~47 km loop: north 20 km on x=0, back south on x=1000 through ten 600 m switchbacks between y=12000 and
    y=10500. ``sign=-1`` mirrors it west. Its 64-point resample is ~740 m apart and cuts the switchback corners."""
    pts = [(0, 0), (0, 20000), (1000, 20000), (1000, 12000)]
    pts += [(1600 if k % 2 == 0 else 1000, 12000 - 150 * (k + 1)) for k in range(10)]
    pts += [(1000, 0), (0, 0)]
    return _path([(sign * x, y) for x, y in pts])


def test_via_feature_measures_against_the_full_track():
    # "Debeli hrib" lies 1 m from a resample chord across the last hairpin but ~150 m from the ride itself;
    # "Prevala" lies 30 m off the ride. Only the ride passes Prevala.
    index = PointIndex([_osm("1", "village", "Koseze", 0, 20500),
                        _osm("2", "peak", "Debeli hrib", 1210, 10400), _osm("3", "pass", "Prevala", 1030, 9000)])
    a = _track("a", _switchback_ride(1), type_="Ride", distance=46_700)
    b = _track("b", _switchback_ride(-1), type_="Ride", distance=46_300, start="2024-06-03T07:00:00+00:00")
    assert _route_names([a, b], index) == {"a": "Koseze loop via Prevala", "b": "Koseze loop, 46.3 km"}


def test_collision_falls_back_to_distance_then_since():
    index = PointIndex([_osm("1", "neighbourhood", "Koseze", 0, 3100)])
    june = "2024-06-03T07:00:00+00:00"
    a = _track("a", _loop_route(300, 300), distance=10_000)
    b = _track("b", _loop_route(-300, 300), distance=10_400, start=june)
    assert _route_names([a, b], index) == {"a": "Koseze loop, 10.0 km", "b": "Koseze loop, 10.4 km"}
    b = _track("b", _loop_route(-300, 300), distance=10_020, start=june)
    assert _route_names([a, b], index) == {"a": "Koseze loop, since May 2024", "b": "Koseze loop, since Jun 2024"}


def test_unnamed_routes_with_same_distance_get_distinct_names():
    a = _track("a", _loop_route(300, 300), distance=5200)
    b = _track("b", _loop_route(300, 300, dx=5000), distance=5200, start="2024-06-03T07:00:00+00:00")
    assert _route_names([a, b]) == {"a": "5.2 km loop, since May 2024", "b": "5.2 km loop, since Jun 2024"}
    b = _track("b", _loop_route(300, 300, dx=5000), distance=5200, start="2024-05-17T07:00:00+00:00")
    assert _route_names([a, b]) == {"a": "5.2 km loop, since 3 May 2024", "b": "5.2 km loop, since 17 May 2024"}
    # The later anchor by start time gets the number, whatever the ids.
    early = _track("z", _loop_route(300, 300, dx=5000), distance=5200, start="2024-05-03T05:00:00+00:00")
    assert _route_names([a, early]) == {"z": "5.2 km loop, since 3 May 2024", "a": "5.2 km loop, since 3 May 2024 (2)"}
    # The local date wins over UTC.
    local = _track("b", _loop_route(300, 300, dx=5000), distance=5200, start="2024-05-31T23:30:00+00:00",
                   start_local="2024-06-01T01:30:00")
    assert _route_names([a, local]) == {"a": "5.2 km loop, since May 2024", "b": "5.2 km loop, since Jun 2024"}


def test_route_names_unique_within_type():
    index = PointIndex([_osm("1", "neighbourhood", "Novo Brdo", 0, 3100),
                        _osm("2", "park", "Rožnik", 400, 1500), _osm("3", "water", "Ribnik", -400, 1500),
                        _osm("4", "neighbourhood", "Vrtača", 400, -300), _osm("5", "neighbourhood", "Koseze", 0, 12_100)])
    june = "2024-06-03T07:00:00+00:00"
    tracks = [
        _track("r1", _loop_route(400, 400)),
        _track("r2", _loop_route(-400, -400)),
        _track("r3", _loop_route(400, 400)),              # r1 again, the same day
        _track("r4", _loop_route(300, 300), start=june),
        _track("r5", _loop_route(-300, 300), start=june),
        _track("r6", _loop_route(300, 300, dx=5000), start=june),
        _track("r7", _path([(0, 0), (0, 12_000)])),
        _track("r8", _path([(0, 0), (0, 12_000)]), start=june),
        _track("w1", _loop_route(400, 400), type_="Walk"),
        _track("w2", _loop_route(400, 400), type_="Walk"),
    ]
    for idx in (index, EMPTY):
        names = _route_names(tracks, idx)
        assert all(names.values())
        by_type = Counter((t.type, names[t.id]) for t in tracks)
        assert max(by_type.values()) == 1, by_type
