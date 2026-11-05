"""The activity filter shared by every activity tool, as SQL on alias ``a``."""
from dataclasses import dataclass

LOCAL_DATE = "substr(a.start_local, 1, 10)"


@dataclass
class ActivityFilter:
    types: list[str] | None = None
    date_from: str | None = None  # inclusive local YYYY-MM-DD
    date_to: str | None = None    # inclusive local YYYY-MM-DD
    name_contains: str | None = None
    min_distance_m: float | None = None
    max_distance_m: float | None = None
    min_moving_s: float | None = None
    has_hr: bool | None = None
    has_gps: bool | None = None
    include_hidden: bool = False


def _num(x: float) -> str:
    return f"{x:g}"


def where_sql(f: ActivityFilter) -> tuple[str, list, list[str]]:
    """(SQL condition, params, human-readable rules for ``counted.rules``)."""
    conds: list[str] = []
    params: list = []
    rules: list[str] = []
    if f.include_hidden:
        rules.append("hidden activities included")
    else:
        conds.append("a.visible = 1")
        rules.append("visible activities only")
    if f.types:
        conds.append(f"a.type IN ({', '.join('?' * len(f.types))})")
        params += list(f.types)
        rules.append("types: " + ", ".join(f.types))
    if f.date_from or f.date_to:
        if f.date_from:
            conds.append(f"{LOCAL_DATE} >= ?")
            params.append(f.date_from)
        if f.date_to:
            conds.append(f"{LOCAL_DATE} <= ?")
            params.append(f.date_to)
        rules.append(f"local start date {f.date_from or '…'}..{f.date_to or '…'}")
    if f.name_contains:
        conds.append("instr(lower(a.name), lower(?)) > 0")
        params.append(f.name_contains)
        rules.append(f"name contains {f.name_contains!r}")
    if f.min_distance_m is not None:
        conds.append("a.distance >= ?")
        params.append(f.min_distance_m)
        rules.append(f"distance >= {_num(f.min_distance_m)} m")
    if f.max_distance_m is not None:
        conds.append("a.distance <= ?")
        params.append(f.max_distance_m)
        rules.append(f"distance <= {_num(f.max_distance_m)} m")
    if f.min_moving_s is not None:
        conds.append("a.moving_time >= ?")
        params.append(f.min_moving_s)
        rules.append(f"moving time >= {_num(f.min_moving_s)} s")
    if f.has_hr is not None:
        conds.append("a.has_hr = ?")
        params.append(int(f.has_hr))
        rules.append("with heart rate" if f.has_hr else "without heart rate")
    if f.has_gps is not None:
        conds.append("a.has_gps = ?")
        params.append(int(f.has_gps))
        rules.append("with GPS" if f.has_gps else "without GPS")
    return (" AND ".join(conds) or "1"), params, rules
