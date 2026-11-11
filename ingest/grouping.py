"""Group activities into places (where they climbed to) and same routes. Pure apart from reading tracks:
it imports ``geometry`` and ``codec`` and nothing else from ingest."""
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import polyline

from ingest import codec
from ingest.geometry import Top, discrete_frechet, haversine_m, project, resample, track_top

PLACE_RADIUS_M = 500
ROUTE_POINTS = 64
ROUTE_DISTANCE_TOLERANCE = 0.15
ROUTE_START_NEAR_M = 1000
ROUTE_MAX_FRECHET_M = 250


@dataclass(frozen=True)
class ActivityTrack:
    id: str
    type: str
    start_time: str              # UTC ISO, the sort key with id
    start_local: str | None
    name: str
    distance: float | None
    line: tuple[tuple[float, float], ...]   # decoded activities.polyline
    top: Top | None


@dataclass(frozen=True)
class Groups:
    place_of: dict[str, str]
    route_of: dict[str, str]
    place_anchors: frozenset[str]


def _top(lat_blob, lon_blob, alt_blob) -> Top | None:
    if lat_blob is None or lon_blob is None or alt_blob is None:
        return None
    return track_top(codec.decode("lat", lat_blob), codec.decode("lon", lon_blob),
                     codec.decode("altitude", alt_blob))


def load_tracks(conn) -> list[ActivityTrack]:
    """Visible activities with a polyline of at least two points, by (start_time, id). ``top`` is None
    without a streams row or without altitude."""
    rows = conn.execute(
        "SELECT a.id, a.type, a.start_time, a.start_local, a.name, a.distance, a.polyline,"
        " s.lat, s.lon, s.altitude"
        " FROM activities a LEFT JOIN streams s ON s.file_sha256 = a.streams_sha256"
        " WHERE a.visible = 1 AND a.polyline != ''"
        " ORDER BY a.start_time, a.id"
    ).fetchall()
    tracks = []
    for r in rows:
        line = tuple(tuple(p) for p in polyline.decode(r[6], 5))
        if len(line) < 2:
            continue
        tracks.append(ActivityTrack(id=r[0], type=r[1], start_time=r[2], start_local=r[3], name=r[4] or "",
                                    distance=r[5], line=line, top=_top(r[7], r[8], r[9])))
    return tracks


def _places(tracks: Sequence[ActivityTrack]) -> dict[str, str]:
    anchors: list[ActivityTrack] = []
    place_of: dict[str, str] = {}
    for t in tracks:
        if t.top is None:
            continue
        for a in anchors:
            if haversine_m(a.top.lat, a.top.lon, t.top.lat, t.top.lon) <= PLACE_RADIUS_M:
                place_of[t.id] = a.id
                break
        else:
            anchors.append(t)
            place_of[t.id] = t.id
    return place_of


def _merge_target(place: str, merges: Mapping[str, str], anchors: frozenset[str]) -> str:
    seen = {place}
    while merges.get(place) in anchors and merges[place] not in seen:
        place = merges[place]
        seen.add(place)
    return place


def _same_route(anchor: ActivityTrack, anchor_xy, t: ActivityTrack) -> bool:
    a, b = anchor.distance, t.distance
    if abs(a - b) > ROUTE_DISTANCE_TOLERANCE * max(a, b):
        return False
    start = t.line[0]
    if min(haversine_m(*start, *anchor.line[0]), haversine_m(*start, *anchor.line[-1])) > ROUTE_START_NEAR_M:
        return False
    xy = resample(project(t.line, anchor.line[0]), ROUTE_POINTS)
    return min(discrete_frechet(anchor_xy, xy), discrete_frechet(anchor_xy, xy[::-1])) < ROUTE_MAX_FRECHET_M


def _routes(tracks: Sequence[ActivityTrack]) -> dict[str, str]:
    anchors: dict[str, list[tuple[ActivityTrack, list[tuple[float, float]]]]] = {}
    route_of: dict[str, str] = {}
    for t in tracks:
        if t.distance is None:
            continue
        of_type = anchors.setdefault(t.type, [])
        for anchor, anchor_xy in of_type:
            if _same_route(anchor, anchor_xy, t):
                route_of[t.id] = anchor.id
                break
        else:
            of_type.append((t, resample(project(t.line, t.line[0]), ROUTE_POINTS)))
            route_of[t.id] = t.id
    sizes: dict[str, int] = {}
    for g in route_of.values():
        sizes[g] = sizes.get(g, 0) + 1
    return {k: g for k, g in route_of.items() if sizes[g] >= 2}


def group_activities(tracks: Sequence[ActivityTrack], merges: Mapping[str, str] = {}) -> Groups:
    """Places and same-route groups, each keyed by its anchor (the earliest member by (start_time, id)).
    ``merges`` maps a place id to the place it joins; chains are followed and targets outside
    ``place_anchors`` are ignored. ``route_of`` leaves out one-activity routes."""
    ordered = sorted(tracks, key=lambda t: (t.start_time, t.id))
    places = _places(ordered)
    place_anchors = frozenset(places.values())
    place_of = {k: _merge_target(p, merges, place_anchors) for k, p in places.items()}
    return Groups(place_of=place_of, route_of=_routes(ordered), place_anchors=place_anchors)
