"""Which activities came near a point.

``closest_approach`` is deliberately free of database code: a later job can run
it for every activity against a list of named places (peaks, huts, lakes) and
store the hits ("place tags"), reusing the same matching.
"""
import math
from datetime import datetime, timedelta

import polyline as polyline_codec

from ingest import codec

from .activities import counted
from .database import Database
from .filters import LOCAL_DATE, ActivityFilter, where_sql

EARTH_RADIUS_M = 6_371_000
M_PER_DEG_LAT = 111_320
DEFAULT_RADIUS_M = 200
MAX_RADIUS_M = 50_000
MODES = {"route": "anywhere on the route", "start": "the start", "end": "the end"}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def closest_approach(lats: list[float | None], lons: list[float | None], lat: float,
                     lon: float) -> tuple[float, int] | None:
    """(distance in m, sample index) of the track point nearest to (lat, lon);
    None when the track has no points. Missing samples are skipped."""
    best = None
    for i, (a, b) in enumerate(zip(lats, lons)):
        if a is None or b is None:
            continue
        d = haversine_m(a, b, lat, lon)
        if best is None or d < best[0]:
            best = (d, i)
    return best


def _track(db: Database, sha: str | None, encoded: str | None):
    """(lats, lons, times or None, source) from the stream, else the polyline."""
    if sha:
        s = db.conn.execute("SELECT time, lat, lon FROM streams WHERE file_sha256 = ?", (sha,)).fetchone()
        if s and s["lat"] is not None and s["lon"] is not None:
            times = codec.decode("time", s["time"]) if s["time"] is not None else None
            return codec.decode("lat", s["lat"]), codec.decode("lon", s["lon"]), times, "stream"
    if encoded:
        pts = polyline_codec.decode(encoded, 5)
        return [p[0] for p in pts], [p[1] for p in pts], None, "polyline"
    return None


def _clock(start_local: str | None, elapsed_s: float | None) -> str | None:
    if not start_local or elapsed_s is None:
        return None
    return (datetime.fromisoformat(start_local) + timedelta(seconds=elapsed_s)).strftime("%H:%M")


def activities_near(db: Database, lat: float, lon: float, radius_m: float = DEFAULT_RADIUS_M,
                    mode: str = "route", f: ActivityFilter | None = None, limit: int = 50) -> dict:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    if not 0 < radius_m <= MAX_RADIUS_M:
        raise ValueError(f"radius_m must be between 1 and {MAX_RADIUS_M}")
    where, params, rules = where_sql(f or ActivityFilter())
    dlat = radius_m / M_PER_DEG_LAT
    dlon = radius_m / (M_PER_DEG_LAT * max(math.cos(math.radians(lat)), 1e-6))
    if mode == "start":
        box = "a.start_lat BETWEEN ? AND ? AND a.start_lng BETWEEN ? AND ?"
        box_params = [lat - dlat, lat + dlat, lon - dlon, lon + dlon]
    else:
        box = "a.min_lat <= ? AND a.max_lat >= ? AND a.min_lng <= ? AND a.max_lng >= ?"
        box_params = [lat + dlat, lat - dlat, lon + dlon, lon - dlon]
    candidates = db.conn.execute(
        f"SELECT a.id, {LOCAL_DATE} AS date_local, a.start_local, a.type, a.name, a.start_lat, a.start_lng, "
        f"a.streams_sha256, a.polyline FROM activities a WHERE {where} AND {box}",
        params + box_params,
    ).fetchall()
    hits = []
    for c in candidates:
        if mode == "start":
            d, at, source = haversine_m(c["start_lat"], c["start_lng"], lat, lon), 0.0, "start point"
        else:
            track = _track(db, c["streams_sha256"], c["polyline"])
            if track is None:
                continue
            lats, lons, times, source = track
            if mode == "end":
                idx = max((i for i, (a, b) in enumerate(zip(lats, lons)) if a is not None and b is not None),
                          default=None)
                if idx is None:
                    continue
                d = haversine_m(lats[idx], lons[idx], lat, lon)
            else:
                best = closest_approach(lats, lons, lat, lon)
                if best is None:
                    continue
                d, idx = best
            at = times[idx] if times else None
        if d <= radius_m:
            hits.append({
                "id": c["id"], "date_local": c["date_local"], "type": c["type"], "name": c["name"],
                "closest_m": round(d), "at_elapsed_s": None if at is None else round(at),
                "at_local_time": _clock(c["start_local"], at), "source": source,
            })
    hits.sort(key=lambda h: (h["closest_m"], h["date_local"] or ""))
    rules.append(f"within {radius_m:g} m of {lat:g}, {lon:g} ({MODES[mode]})")
    return {
        "data": {"rows": hits[:limit], "total": len(hits), "truncated": len(hits) > limit},
        "counted": counted(rules, len(hits)),
    }
