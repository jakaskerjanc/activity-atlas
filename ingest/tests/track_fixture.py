"""Synthetic GPS tracks and an activity inserter for geometry, grouping and naming tests."""
import math

from ingest.geometry import haversine_m
from ingest.tests.mcp_fixture import _insert_activity

_M_PER_DEG = 111_195.0


def offset(points, east_m: float, north_m: float):
    """Shift every (lat, lon) point by metres east and north."""
    out = []
    for lat, lon in points:
        out.append((lat + north_m / _M_PER_DEG,
                    lon + east_m / (_M_PER_DEG * math.cos(math.radians(lat)))))
    return out


def line(start: tuple, bearing_deg: float, length_m: float, n: int) -> list[tuple]:
    b = math.radians(bearing_deg)
    pts = []
    for i in range(n):
        d = length_m * i / (n - 1)
        pts.append(offset([start], d * math.sin(b), d * math.cos(b))[0])
    return pts


def loop(center: tuple, radius_m: float, n: int, start_deg: float = 0) -> list[tuple]:
    """A closed circle of n points (the last equals the first) around center."""
    pts = []
    for i in range(n):
        a = math.radians(start_deg + 360.0 * i / (n - 1))
        pts.append(offset([center], radius_m * math.sin(a), radius_m * math.cos(a))[0])
    return pts


def out_and_back(start, bearing_deg: float, length_m: float, n: int):
    half = n // 2 + 1
    out = line(start, bearing_deg, length_m, half)
    return out + out[-2::-1][: n - half]


def climb_alts(n: int, gain_m: float):
    """Altitude rising evenly to the midpoint, then falling."""
    mid = (n - 1) / 2
    return [300.0 + gain_m * (1 - abs(i - mid) / mid) for i in range(n)]


def insert_activity(conn, id_, type_, start_utc, points, *, alts=None, name=None, distance=None, visible=1):
    if distance is None:
        distance = sum(haversine_m(*a, *b) for a, b in zip(points, points[1:]))
    track = {
        "time": [i * 10.0 for i in range(len(points))],
        "lat": [p[0] for p in points],
        "lon": [p[1] for p in points],
    }
    if alts is not None:
        track["altitude"] = list(alts)
    _insert_activity(conn, id_, type_, start_utc, name=name, distance=distance, visible=visible, track=track)
