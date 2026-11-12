"""Names for places and routes. The module layering keeps ``naming`` free of ``osm``: it imports only
``geometry`` and ``grouping``'s types."""
import math
import re
import unicodedata
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass

from ingest.geometry import (EARTH_RADIUS_M, farthest_index, haversine_m, polyline_dist, project, resample,
                             route_shape)
from ingest.grouping import ROUTE_POINTS, ActivityTrack, Groups


@dataclass(frozen=True)
class OsmPoint:
    osm_id: str
    kind: str
    name: str
    lat: float
    lon: float
    ele: float | None


@dataclass(frozen=True)
class PlaceInfo:
    id: str
    name: str
    name_source: str      # owner | activity_names | osm | fallback
    kind: str             # peak | pass | top
    ele: float


@dataclass(frozen=True)
class RouteInfo:
    id: str
    name: str
    name_source: str      # owner | auto


# --- the point index and naming a point -----------------------------------------------------------------------

GRID_DEG = 0.05
_M_PER_DEG = math.pi / 180 * EARTH_RADIUS_M


class PointIndex:
    """Named OSM points on a 0.05° grid. An empty index is valid and finds nothing."""

    def __init__(self, points: Iterable[OsmPoint]):
        self._cells: dict[tuple[int, int], list[OsmPoint]] = {}
        for p in points:
            self._cells.setdefault(self._cell(p.lat, p.lon), []).append(p)

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        return math.floor(lat / GRID_DEG), math.floor(lon / GRID_DEG)

    def near(self, lat: float, lon: float, radius_m: float, kinds: Collection[str]) -> list[tuple[float, OsmPoint]]:
        """Points of ``kinds`` within ``radius_m``, nearest first (ties by osm_id)."""
        dlat = radius_m / _M_PER_DEG
        dlon = radius_m / (_M_PER_DEG * max(math.cos(math.radians(lat)), 1e-6))
        (r0, c0), (r1, c1) = self._cell(lat - dlat, lon - dlon), self._cell(lat + dlat, lon + dlon)
        hits = []
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                for p in self._cells.get((r, c), ()):
                    if p.kind in kinds:
                        d = haversine_m(lat, lon, p.lat, p.lon)
                        if d <= radius_m:
                            hits.append((d, p))
        return sorted(hits, key=lambda h: (h[0], h[1].osm_id))


POINT_RADII: tuple[tuple[tuple[str, ...], float], ...] = (
    (("peak", "pass"), 150), (("park",), 250), (("water",), 150), (("neighbourhood",), 800),
    (("quarter", "hamlet"), 1000), (("suburb",), 1500), (("village",), 2000))
ALL_KINDS = frozenset(k for kinds, _ in POINT_RADII for k in kinds)


def name_point(lat: float, lon: float, index: PointIndex) -> str | None:
    """The nearest point of the first kind tuple in ``POINT_RADII`` with a hit."""
    for kinds, radius in POINT_RADII:
        hits = index.near(lat, lon, radius, kinds)
        if hits:
            return hits[0][1].name
    return None


# --- places ---------------------------------------------------------------------------------------------------

PLACE_PEAK_RADIUS_M = 400
PEAK_KINDS = ("peak", "pass")
_DEFAULT_NAMES = (
    re.compile(r"^\W*(morning|afternoon|evening|night|lunch)\s+(run|ride|hike|walk|swim|workout)\W*$", re.IGNORECASE),
    re.compile(r"^\W*.+\s+(walking|hiking|running|trail running|cycling|road cycling|mountain biking|biking"
               r"|gravel cycling)\s*$", re.IGNORECASE),
)
GENERIC_WORDS = frozenset("""
    morning afternoon evening night lunch hike hiking walk walking run running ride riding trail the to and of with
    via from on at up down summit attempt day trip loop tour gravel bike cycling
    easy tempo long short recovery weekend hill hills spin after work commute interval intervals race
    monday tuesday wednesday thursday friday saturday sunday
    riverside forest dinner out back above below climb flat laps
    na in do od po pri čez pohod izlet sprehod tek vzpon krog okoli iz proti nad pod ob kolo
""".split())
_LETTERS = re.compile(r"[^\W\d_]+")


def is_default_name(name: str) -> bool:
    """Automatic names like "Morning Hike" or "‹town› Walking", which add no words."""
    return any(p.match(name) for p in _DEFAULT_NAMES)


def _kept(token: str) -> bool:
    return len(token) >= 3 and token.lower() not in GENERIC_WORDS


def _tokens(name: str) -> list[str]:
    return _LETTERS.findall(unicodedata.normalize("NFC", name))


def name_words(name: str) -> list[str]:
    """Lowercase letter runs of 3 or more letters, without ``GENERIC_WORDS``. No stemming."""
    return [t.lower() for t in _tokens(name) if _kept(t)]


def _phrases(name: str) -> list[tuple[tuple[str, ...], str]]:
    """(key, spelling) for every kept word and every bigram of two kept words with no dropped word between."""
    tokens = _tokens(name)
    kept = [(i, t) for i, t in enumerate(tokens) if _kept(t)]
    out = [((t.lower(),), t) for _, t in kept]
    out += [((a.lower(), b.lower()), f"{a} {b}") for (i, a), (j, b) in zip(kept, kept[1:]) if j == i + 1]
    return out


def _repeated_phrase(names: Sequence[str]) -> str | None:
    """The phrase repeated in the most names (at least 2), spelled as in the earliest; see the module rules."""
    count: dict[tuple[str, ...], int] = {}
    spelling: dict[tuple[str, ...], str] = {}   # insertion order is the order of first appearance
    for name in names:
        seen: set[tuple[str, ...]] = set()
        for key, spelled in _phrases(name):
            if key not in seen:       # once per name
                seen.add(key)
                count[key] = count.get(key, 0) + 1
                spelling.setdefault(key, spelled)
    best = max((c for k, c in count.items() if len(k) == 1), default=0)
    if best < 2:
        return None
    for size in (2, 1):
        for key in spelling:
            if len(key) == size and count[key] == best:
                return spelling[key]
    return None


def _starts_with_phrase(osm_name: str, phrase: str) -> bool:
    return re.match(re.escape(phrase) + r"(?![^\W\d_])", unicodedata.normalize("NFC", osm_name),
                    re.IGNORECASE) is not None


def _round10(ele: float) -> float:
    return float(math.floor(ele / 10 + 0.5) * 10)


def _name_place(pid: str, members: Sequence[ActivityTrack], index: PointIndex, owner: str | None) -> PlaceInfo:
    top = max((m.top for m in members), key=lambda t: t.ele)
    peaks = [p for _, p in index.near(top.lat, top.lon, PLACE_PEAK_RADIUS_M, PEAK_KINDS)]
    nearest = peaks[0] if peaks else None
    rounded = _round10(top.ele)
    kind = nearest.kind if nearest else "top"
    ele = nearest.ele if nearest and nearest.ele is not None else rounded

    def info(name: str, source: str) -> PlaceInfo:
        return PlaceInfo(pid, name, source, kind, ele)

    if owner:
        return info(owner, "owner")
    if len(members) >= 2:
        phrase = _repeated_phrase([m.name for m in members if not is_default_name(m.name)])
        if phrase:
            osm = next((p.name for p in peaks if _starts_with_phrase(p.name, phrase)), phrase)
            return info(osm, "activity_names")
    if nearest:
        return info(nearest.name, "osm")
    return info(f"Top at {int(rounded):,} m", "fallback")


def name_places(groups: Groups, tracks: Iterable[ActivityTrack], index: PointIndex,
                owner_names: Mapping[str, str]) -> dict[str, PlaceInfo]:
    """Every place in ``groups.place_of``, by the rules: owner, repeated words, OSM peak or pass, "Top at"."""
    members: dict[str, list[ActivityTrack]] = {}
    for t in sorted(tracks, key=lambda t: (t.start_time, t.id)):
        pid = groups.place_of.get(t.id)
        if pid is not None and t.top is not None:
            members.setdefault(pid, []).append(t)
    return {pid: _name_place(pid, ms, index, owner_names.get(pid)) for pid, ms in members.items()}


# --- routes ---------------------------------------------------------------------------------------------------

END_SKIP_M = 500
VIA_FEATURE_M = 75
VIA_OTHERS_M = 150
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


@dataclass(frozen=True)
class _Route:
    track: ActivityTrack
    base: str
    has_distance: bool    # the base is the unnamed "{km} km {shape}"

    @property
    def id(self) -> str:
        return self.track.id


def _xy(t: ActivityTrack, origin: tuple[float, float]) -> list[tuple[float, float]]:
    return resample(project(t.line, origin), ROUTE_POINTS)


def _unproject(p: tuple[float, float], origin: tuple[float, float]) -> tuple[float, float]:
    lat0, lon0 = origin
    return lat0 + p[1] / _M_PER_DEG, lon0 + p[0] / (_M_PER_DEG * math.cos(math.radians(lat0)))


def _km(t: ActivityTrack) -> str:
    return f"{(t.distance or 0) / 1000:.1f} km"


def _route_base(t: ActivityTrack, place: PlaceInfo | None, index: PointIndex) -> _Route:
    xy = _xy(t, t.line[0])
    shape = route_shape(xy)
    if place is not None:
        return _Route(t, f"{place.name} {shape}", False)
    if shape == "point-to-point":
        start, end = name_point(*t.line[0], index), name_point(*t.line[-1], index)
        if start is not None and end is not None and start != end:
            return _Route(t, f"{start} → {end}", False)
    # A point-to-point without a place and without two different end names is named like a loop.
    turn = name_point(*_unproject(xy[farthest_index(xy, skip_m=END_SKIP_M)], t.line[0]), index)
    if turn is not None:
        return _Route(t, f"{turn} {'loop' if shape == 'point-to-point' else shape}", False)
    return _Route(t, f"{_km(t)} {shape}", True)


def _via_divergence(r: _Route, others: Sequence[_Route], index: PointIndex) -> str | None:
    """Tiebreak 1: name the point of r farthest from the others, ignoring the first and last 500 m."""
    origin = r.track.line[0]
    rxy = _xy(r.track, origin)
    oxy = [p for o in others for p in _xy(o.track, origin)]
    kept = [i for i, p in enumerate(rxy)
            if math.dist(p, rxy[0]) >= END_SKIP_M and math.dist(p, rxy[-1]) >= END_SKIP_M]
    if not kept or not oxy:
        return None
    far = max(kept, key=lambda i: min(math.dist(rxy[i], q) for q in oxy))
    via = name_point(*_unproject(rxy[far], origin), index)
    return None if via is None or via in r.base else f"{r.base} via {via}"


def _via_feature(r: _Route, others: Sequence[_Route], index: PointIndex) -> str | None:
    """Tiebreak 2: a named point of any kind within 75 m of r and more than 150 m from every other route, and,
    as in tiebreak 1, not within 500 m of r's first or last point. When several qualify, the one nearest to r
    wins (ties by osm_id). Both distances are to the full tracks: the 64-point resample only seeds the
    search, since its chords cut corners on long, curvy routes."""
    origin = r.track.line[0]
    line = project(r.track.line, origin)
    others_xy = [project(o.track.line, origin) for o in others]
    step = sum(math.dist(a, b) for a, b in zip(line, line[1:])) / (ROUTE_POINTS - 1)
    # Every point of the track is within step / 2 along it of a seed; a full step leaves room for rounding.
    reach = VIA_FEATURE_M + step
    found: dict[str, tuple[float, OsmPoint]] = {}
    checked: set[str] = set()
    for p in resample(line, ROUTE_POINTS):
        for _, pt in index.near(*_unproject(p, origin), reach, ALL_KINDS):
            if pt.osm_id in checked or pt.name in r.base:
                continue
            checked.add(pt.osm_id)
            fxy = project([(pt.lat, pt.lon)], origin)[0]
            if math.dist(fxy, line[0]) < END_SKIP_M or math.dist(fxy, line[-1]) < END_SKIP_M:
                continue
            d = polyline_dist(fxy, line)
            if d <= VIA_FEATURE_M and all(polyline_dist(fxy, o) > VIA_OTHERS_M for o in others_xy):
                found[pt.osm_id] = (d, pt)
    if not found:
        return None
    _, best = min(found.values(), key=lambda h: (h[0], h[1].osm_id))
    return f"{r.base} via {best.name}"


def _with_distance(r: _Route, others: Sequence[_Route], index: PointIndex) -> str | None:
    return None if r.has_distance else f"{r.base}, {_km(r.track)}"


def _ymd(t: ActivityTrack) -> tuple[int, int, int]:
    y, m, d = (t.start_local or t.start_time)[:10].split("-")
    return int(y), int(m), int(d)


def _since_month(r: _Route, others: Sequence[_Route], index: PointIndex) -> str | None:
    y, m, _ = _ymd(r.track)
    return f"{r.base}, since {MONTHS[m - 1]} {y}"


def _since_day(r: _Route) -> str:
    y, m, d = _ymd(r.track)
    return f"{r.base}, since {d} {MONTHS[m - 1]} {y}"


_TIEBREAKS: tuple[Callable[[_Route, Sequence[_Route], PointIndex], str | None], ...] = (
    _via_divergence, _via_feature, _with_distance, _since_month)


def _break_ties(routes: Sequence[_Route], index: PointIndex, reserved: Collection[str] = ()) -> dict[str, str]:
    """Names for one type's automatic routes, unique among them and never one of ``reserved`` (the type's
    owner names). Colliding routes, and a route whose base is reserved, go through the tiebreaks level by
    level; each settles at the first level whose result is unique, as base plus one suffix."""
    reserved = set(reserved)
    by_base: dict[str, list[_Route]] = {}
    for r in routes:
        by_base.setdefault(r.base, []).append(r)

    def collides(r: _Route) -> bool:
        return len(by_base[r.base]) > 1 or r.base in reserved

    names = {r.id: r.base for r in routes if not collides(r)}
    pending = [r for r in routes if collides(r)]
    for tiebreak in _TIEBREAKS:
        if not pending:
            break
        taken = set(names.values()) | reserved
        cand = {r.id: tiebreak(r, [o for o in by_base[r.base] if o is not r], index) for r in pending}
        for r in pending:
            c = cand[r.id]
            if c is not None and c not in taken and all(cand[o.id] != c for o in pending if o is not r):
                names[r.id] = c
        pending = [r for r in pending if r.id not in names]
    seen: dict[str, int] = {}
    taken = set(names.values()) | reserved
    for r in pending:     # already in anchor order
        name = _since_day(r)
        n = seen.get(name, 0) + 1
        while (name if n == 1 else f"{name} ({n})") in taken:
            n += 1
        seen[name] = n
        names[r.id] = name if n == 1 else f"{name} ({n})"
        taken.add(names[r.id])
    return names


def name_routes(groups: Groups, tracks: Iterable[ActivityTrack], places: Mapping[str, PlaceInfo],
                index: PointIndex, owner_names: Mapping[str, str]) -> dict[str, RouteInfo]:
    """Every route in ``groups.route_of``, named from its anchor track. Owner names win and never get a
    suffix; the rest get a base and, when it collides within a type with another base or an owner name of
    that type, a tiebreak."""
    by_id = {t.id: t for t in tracks}
    anchors = sorted((by_id[r] for r in set(groups.route_of.values())), key=lambda t: (t.start_time, t.id))
    out: dict[str, RouteInfo] = {}
    auto: dict[str, list[_Route]] = {}
    owned: dict[str, set[str]] = {}
    for t in anchors:
        owner = owner_names.get(t.id)
        if owner:
            out[t.id] = RouteInfo(t.id, owner, "owner")
            owned.setdefault(t.type, set()).add(owner)
            continue
        pid = groups.place_of.get(t.id)
        auto.setdefault(t.type, []).append(_route_base(t, places.get(pid) if pid else None, index))
    for type_, routes in auto.items():
        for rid, name in _break_ties(routes, index, owned.get(type_, ())).items():
            out[rid] = RouteInfo(rid, name, "auto")
    return {t.id: out[t.id] for t in anchors}
