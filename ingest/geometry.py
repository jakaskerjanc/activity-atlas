"""Track geometry for places and same-route groups. A leaf module: it imports nothing from ingest."""
import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import accumulate

EARTH_RADIUS_M = 6_371_008.8
MIN_CLIMB_M = 50.0
TOP_SAMPLE_MIN = 30
BASE_INDEX = 15
POINT_TO_POINT_M = 200.0
OUT_AND_BACK_M = 50.0
OUT_AND_BACK_SHARE = 0.7


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def project(points: Sequence[tuple[float, float]], origin: tuple[float, float]) -> list[tuple[float, float]]:
    """Equirectangular metres around origin; x is scaled by cos(origin latitude)."""
    lat0, lon0 = origin
    k = math.cos(math.radians(lat0))
    m = math.pi / 180 * EARTH_RADIUS_M
    return [((lon - lon0) * m * k, (lat - lat0) * m) for lat, lon in points]


def resample(xy: Sequence[tuple[float, float]], n: int = 64) -> list[tuple[float, float]]:
    """n points evenly spaced by path length; a zero-length path gives n copies of the first point."""
    cum = list(accumulate(map(math.dist, xy, xy[1:]), initial=0.0))
    total = cum[-1]
    if total == 0:
        return [tuple(xy[0])] * n
    out = []
    j = 0
    for i in range(n):
        target = total * i / (n - 1)
        while j < len(xy) - 2 and cum[j + 1] < target:
            j += 1
        seg = cum[j + 1] - cum[j]
        t = 0.0 if seg == 0 else min(1.0, (target - cum[j]) / seg)
        out.append((xy[j][0] + (xy[j + 1][0] - xy[j][0]) * t, xy[j][1] + (xy[j + 1][1] - xy[j][1]) * t))
    return out


def discrete_frechet(p: Sequence[tuple[float, float]], q: Sequence[tuple[float, float]]) -> float:
    prev: list[float] = []
    for i, a in enumerate(p):
        row: list[float] = []
        for j, b in enumerate(q):
            d = math.dist(a, b)
            if i == 0 and j == 0:
                v = d
            elif i == 0:
                v = max(row[j - 1], d)
            elif j == 0:
                v = max(prev[0], d)
            else:
                v = max(min(prev[j], prev[j - 1], row[j - 1]), d)
            row.append(v)
        prev = row
    return prev[-1]


def frechet_below(p: Sequence[tuple[float, float]], q: Sequence[tuple[float, float]], limit: float) -> bool:
    """Whether ``discrete_frechet(p, q) < limit``, without filling the whole table. The distance is the
    smallest largest pair over the monotone couplings of p and q, so it is below ``limit`` exactly when some
    coupling uses only pairs nearer than ``limit``. Row by row this keeps the pairs such a coupling reaches,
    measures only pairs next to one, and gives up on a row that reaches none. Every coupling holds both end
    pairs, so those are checked first."""
    if math.dist(p[0], q[0]) >= limit or math.dist(p[-1], q[-1]) >= limit:
        return False
    m = len(q)
    a = p[0]
    hi = 0
    while hi + 1 < m and math.dist(a, q[hi + 1]) < limit:
        hi += 1
    prev = [j <= hi for j in range(m)]
    lo = 0                # the row before reaches only cells in [lo, hi]
    for a in p[1:]:
        row = [False] * m
        left = False
        new_lo = new_hi = -1
        for j in range(lo, m):
            if left or prev[j] or (j > lo and prev[j - 1]):
                if math.dist(a, q[j]) < limit:
                    row[j] = left = True
                    if new_lo < 0:
                        new_lo = j
                    new_hi = j
                    continue
            elif j > hi:
                break     # neither the row before nor this one reaches anything from here on
            left = False
        if new_lo < 0:
            return False
        prev, lo, hi = row, new_lo, new_hi
    return prev[-1]


def smooth(values: Sequence[float], window: int = 15) -> list[float]:
    """Centred moving average over the samples available at the edges."""
    half = window // 2
    n = len(values)
    out = []
    for i in range(n):
        chunk = values[max(0, i - half):min(n, i + half + 1)]
        out.append(sum(chunk) / len(chunk))
    return out


@dataclass(frozen=True)
class Top:
    lat: float
    lon: float
    ele: float
    climb: float


def track_top(lats, lons, alts) -> Top | None:
    rows = [(a, o, e) for a, o, e in zip(lats, lons, alts) if a is not None and o is not None and e is not None]
    if len(rows) < TOP_SAMPLE_MIN:
        return None
    sm = smooth([r[2] for r in rows])
    k = max(range(len(sm)), key=sm.__getitem__)
    climb = sm[k] - sm[min(BASE_INDEX, len(sm) - 1)]
    if climb < MIN_CLIMB_M:
        return None
    return Top(rows[k][0], rows[k][1], sm[k], climb)


def _segment_dist(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / seg2))
    return math.dist(p, (a[0] + dx * t, a[1] + dy * t))


def polyline_dist(p: tuple[float, float], line: Sequence[tuple[float, float]]) -> float:
    if len(line) == 1:
        return math.dist(p, line[0])
    return min(_segment_dist(p, a, b) for a, b in zip(line, line[1:]))


def route_shape(xy: Sequence[tuple[float, float]]) -> str:
    """Out-and-back when >= 70% of the second half lies within 50 m of the first half's polyline."""
    if math.dist(xy[0], xy[-1]) > POINT_TO_POINT_M:
        return "point-to-point"
    half = len(xy) // 2
    first, second = xy[:half], xy[half:]
    near = sum(1 for s in second if polyline_dist(s, first) <= OUT_AND_BACK_M)
    return "out-and-back" if near >= OUT_AND_BACK_SHARE * len(second) else "loop"


def farthest_index(xy: Sequence[tuple[float, float]], skip_m: float = 0.0) -> int:
    """Index farthest from xy[0], ignoring points within skip_m of the first or last point."""
    first, last = xy[0], xy[-1]
    dist = [math.dist(first, p) for p in xy]
    kept = [i for i, p in enumerate(xy) if math.dist(first, p) >= skip_m and math.dist(last, p) >= skip_m]
    return max(kept or range(len(xy)), key=dist.__getitem__)
