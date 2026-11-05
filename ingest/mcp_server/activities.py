"""Activity tools: list, get, summarize."""
import json

from .database import Database
from .filters import LOCAL_DATE, ActivityFilter, where_sql

SORTS = {
    "date_desc": "a.start_time DESC",
    "date_asc": "a.start_time ASC",
    "distance_desc": "a.distance DESC NULLS LAST",
    "moving_desc": "a.moving_time DESC NULLS LAST",
    "gain_desc": "a.elevation_gain DESC NULLS LAST",
}
MAX_LIST_ROWS = 1000

# Columns of `activities` that get_activity returns as they are.
_DETAIL_COLUMNS = [
    "id", "name", "type", "start_time", "end_time", "start_local", "utc_offset_s", "elapsed_time",
    "moving_time", "distance", "elevation_gain", "elevation_loss", "avg_hr", "max_hr", "avg_cadence",
    "max_cadence", "avg_power", "max_power", "calories", "aerobic_te", "anaerobic_te", "start_lat",
    "start_lng", "has_gps", "has_hr", "has_altitude", "has_cadence", "has_power", "visible",
]


def pace_str(seconds: float | None, meters: float | None) -> str | None:
    """Minutes:seconds per km, or None when either value is unknown or zero."""
    if not seconds or not meters:
        return None
    s = round(seconds / (meters / 1000))
    return f"{s // 60}:{s % 60:02d}"


def speed_kmh(seconds: float | None, meters: float | None) -> float | None:
    if not seconds or not meters:
        return None
    return round(meters / 1000 / (seconds / 3600), 2)


def _round(x, nd=1):
    return None if x is None else round(x, nd)


def counted(rules: list[str], included: int, excluded: dict | None = None) -> dict:
    return {"rules": rules, "included": included, "excluded": {k: v for k, v in (excluded or {}).items() if v}}


def list_activities(db: Database, f: ActivityFilter, sort: str = "date_desc", limit: int = 200,
                    offset: int = 0) -> dict:
    if sort not in SORTS:
        raise ValueError(f"sort must be one of {', '.join(SORTS)}")
    where, params, rules = where_sql(f)
    limit = max(1, min(limit, MAX_LIST_ROWS))
    total = db.conn.execute(f"SELECT count(*) FROM activities a WHERE {where}", params).fetchone()[0]
    rows = db.conn.execute(
        f"SELECT a.id, {LOCAL_DATE} AS date_local, a.type, a.name, a.distance, a.moving_time, "
        f"a.elevation_gain, a.avg_hr FROM activities a WHERE {where} ORDER BY {SORTS[sort]} "
        "LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    out = [{
        "id": r["id"], "date_local": r["date_local"], "type": r["type"], "name": r["name"],
        "distance_km": None if r["distance"] is None else round(r["distance"] / 1000, 2),
        "moving_min": None if r["moving_time"] is None else round(r["moving_time"] / 60, 1),
        "pace_min_km": pace_str(r["moving_time"], r["distance"]),
        "speed_kmh": speed_kmh(r["moving_time"], r["distance"]),
        "gain_m": _round(r["elevation_gain"], 0),
        "avg_hr": _round(r["avg_hr"], 0),
    } for r in rows]
    return {
        "data": {"rows": out, "total": total, "offset": offset, "truncated": offset + len(out) < total},
        "counted": counted(rules, total),
    }


def get_activity(db: Database, activity_id: str) -> dict:
    a = db.conn.execute(
        f"SELECT {', '.join(_DETAIL_COLUMNS)}, hr_zone_seconds, hr_zone_limits, streams_sha256 "
        "FROM activities WHERE id = ?", (activity_id,),
    ).fetchone()
    if a is None:
        raise ValueError(f"no activity {activity_id}")
    data = {k: a[k] for k in _DETAIL_COLUMNS}
    data["date_local"] = (a["start_local"] or "")[:10] or None
    for k in ("hr_zone_seconds", "hr_zone_limits"):
        data[k] = json.loads(a[k]) if a[k] else None
    data["laps"] = [dict(r) for r in db.conn.execute(
        "SELECT lap_index, start_time, elapsed_s, moving_s, distance_m, avg_hr, max_hr, avg_speed, "
        "elevation_gain_m, elevation_loss_m, avg_cadence, avg_power, trigger "
        "FROM laps WHERE file_sha256 = ? ORDER BY lap_index", (a["streams_sha256"],),
    )] if a["streams_sha256"] else []
    data["gear"] = [r[0] for r in db.conn.execute(
        "SELECT gear_name FROM activity_gear WHERE activity_id = ? ORDER BY gear_name", (activity_id,))]
    data["sources"] = [dict(r) for r in db.conn.execute(
        "SELECT provider, provider_activity_id, url, deleted_at FROM activity_sources "
        "WHERE activity_id = ? ORDER BY provider", (activity_id,))]
    return {"data": data, "counted": counted([] if a["visible"] else ["hidden activity"], 1)}


PERIOD_KEYS = {
    "week": f"date({LOCAL_DATE}, '-6 days', 'weekday 1')",
    "month": "substr(a.start_local, 1, 7)",
    "year": "substr(a.start_local, 1, 4)",
    "all": "'all'",
}

SUMMARY_RULES = [
    "periods by local start date; weeks start on Monday",
    "pace and speed = total moving time / total distance, over activities with both",
    "avg HR = each activity's avg HR weighted by its moving time, over activities with both",
    "unknown values are left out of sums, never counted as 0",
]

_PACE_OK = "a.distance > 0 AND a.moving_time > 0"
_HR_OK = "a.avg_hr IS NOT NULL AND a.moving_time > 0"


def summarize(db: Database, f: ActivityFilter, period: str = "year", by_type: bool = True) -> dict:
    if period not in PERIOD_KEYS:
        raise ValueError(f"period must be one of {', '.join(PERIOD_KEYS)}")
    where, params, rules = where_sql(f)
    group = "period, a.type" if by_type else "period"
    rows = db.conn.execute(
        f"SELECT {PERIOD_KEYS[period]} AS period, {'a.type' if by_type else 'NULL'} AS type, "
        "count(*) AS n, sum(a.distance) AS dist, count(a.distance) AS dist_known, "
        "sum(a.moving_time) AS moving, sum(a.elapsed_time) AS elapsed, "
        "sum(a.elevation_gain) AS gain, count(a.elevation_gain) AS gain_known, "
        f"sum(CASE WHEN {_PACE_OK} THEN a.moving_time END) AS pace_s, "
        f"sum(CASE WHEN {_PACE_OK} THEN a.distance END) AS pace_m, "
        f"count(CASE WHEN {_PACE_OK} THEN 1 END) AS pace_n, "
        f"sum(CASE WHEN {_HR_OK} THEN a.avg_hr * a.moving_time END) AS hr_w, "
        f"sum(CASE WHEN {_HR_OK} THEN a.moving_time END) AS hr_s, "
        f"count(CASE WHEN {_HR_OK} THEN 1 END) AS hr_n "
        f"FROM activities a WHERE {where} GROUP BY {group} ORDER BY {group}",
        params,
    ).fetchall()
    out = []
    for r in rows:
        row = {"period": r["period"]}
        if by_type:
            row["type"] = r["type"]
        row.update({
            "count": r["n"],
            "distance_km": None if not r["dist_known"] else round(r["dist"] / 1000, 2),
            "distance_known": r["dist_known"],
            "moving_h": None if r["moving"] is None else round(r["moving"] / 3600, 2),
            "elapsed_h": None if r["elapsed"] is None else round(r["elapsed"] / 3600, 2),
            "gain_m": _round(r["gain"], 0),
            "gain_known": r["gain_known"],
            "pace_min_km": pace_str(r["pace_s"], r["pace_m"]),
            "speed_kmh": speed_kmh(r["pace_s"], r["pace_m"]),
            "pace_basis_count": r["pace_n"],
            "avg_hr": None if not r["hr_s"] else round(r["hr_w"] / r["hr_s"], 1),
            "hr_known": r["hr_n"],
        })
        out.append(row)
    total = sum(r["n"] for r in rows)
    excluded = {
        "no distance or moving time (pace)": sum(r["n"] - r["pace_n"] for r in rows),
        "no avg HR or moving time (HR)": sum(r["n"] - r["hr_n"] for r in rows),
    }
    return {"data": {"period": period, "rows": out}, "counted": counted(rules + SUMMARY_RULES, total, excluded)}
