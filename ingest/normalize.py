import math
import warnings
from datetime import datetime, timezone

import polyline

from .model import RawActivity, Activity

# Canonical vocabulary (Strava display names collapse into this set).
CANONICAL = {
    "Run", "Ride", "Hike", "Walk", "WeightTraining", "Workout", "Swim",
    "RockClimbing", "Rowing", "StairStepper", "Badminton", "Volleyball",
    "IceSkate", "Tennis",
}

# Garmin snake typeKeys -> canonical. Unmapped keys title-case + warn.
GARMIN_TYPE_MAP = {
    "running": "Run", "trail_running": "Run", "treadmill_running": "Run",
    "indoor_running": "Run", "track_running": "Run",
    "cycling": "Ride", "road_biking": "Ride", "mountain_biking": "Ride",
    "gravel_cycling": "Ride", "virtual_ride": "Ride", "indoor_cycling": "Ride",
    "hiking": "Hike", "mountaineering": "Hike",
    "walking": "Walk", "casual_walking": "Walk", "speed_walking": "Walk",
    "strength_training": "WeightTraining",
    "indoor_cardio": "Workout", "fitness_equipment": "Workout", "other": "Workout",
    "lap_swimming": "Swim", "open_water_swimming": "Swim",
    "indoor_climbing": "RockClimbing", "rock_climbing": "RockClimbing", "bouldering": "RockClimbing",
    "indoor_rowing": "Rowing", "rowing": "Rowing",
    "stair_climbing": "StairStepper",
    "badminton": "Badminton", "volleyball": "Volleyball",
    "ice_skating": "IceSkate", "skating_ws": "IceSkate",
    "tennis": "Tennis", "tennis_v2": "Tennis",
}


def canonical_type(type_raw: str) -> str:
    raw = type_raw.strip()
    pascal = "".join(w.capitalize() for w in raw.replace("-", " ").replace("_", " ").split())
    if pascal in CANONICAL:                       # Strava display names
        return pascal
    key = raw.lower().replace(" ", "_").replace("-", "_")
    if key in GARMIN_TYPE_MAP:                     # Garmin snake keys
        return GARMIN_TYPE_MAP[key]
    warnings.warn(f'Unmapped activity type "{type_raw}" -> "{pascal}". Add it to GARMIN_TYPE_MAP.')
    return pascal


def _perp_m(p, a, b) -> float:
    """Perpendicular distance (m) from p to segment a-b, equirectangular."""
    lat0 = math.radians(a[0]); mx = 111320 * math.cos(lat0); my = 110540
    ax, ay = a[1] * mx, a[0] * my
    bx, by = b[1] * mx, b[0] * my
    px, py = p[1] * mx, p[0] * my
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(track, tol_m: float = 0.5):
    """Iterative Douglas–Peucker in meters (no recursion-depth risk)."""
    n = len(track)
    if n < 3:
        return list(track)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        dmax, idx = 0.0, -1
        for k in range(i + 1, j):
            d = _perp_m(track[k], track[i], track[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > tol_m and idx != -1:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [track[i] for i in range(n) if keep[i]]


def encode(track) -> str:
    if len(track) < 2:
        return ""
    return polyline.encode([(lat, lon) for lat, lon in track], 5)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def normalize(raw: RawActivity, tol_m: float = 0.5) -> Activity:
    poly = encode(simplify(raw.track, tol_m)) if raw.track else ""
    if raw.source == "strava":
        aid, strava_id, garmin_id = f"s:{raw.source_id}", raw.source_id, None
    else:
        aid, strava_id, garmin_id = f"g:{raw.source_id}", None, raw.source_id
    return Activity(
        id=aid, strava_id=strava_id, garmin_id=garmin_id,
        name=raw.name, type=canonical_type(raw.type_raw),
        start_time=_iso(raw.start_time),
        distance=float(raw.distance_m), moving_time=int(raw.moving_time_s),
        elevation_gain=float(raw.elevation_gain_m), polyline=poly,
        start_lat=raw.track[0][0] if raw.track else None,
        start_lng=raw.track[0][1] if raw.track else None,
    )
