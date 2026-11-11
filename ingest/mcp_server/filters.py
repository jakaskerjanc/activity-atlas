"""The activity filter shared by every activity tool, as SQL on alias ``a``."""
import dataclasses
import unicodedata
from dataclasses import dataclass

LOCAL_DATE = "substr(a.start_local, 1, 10)"
GROUP_TABLES = ("places", "route_groups", "activity_groups")
NO_PLACES_YET = "this database has no places yet; they appear after the next write job"


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
    place: str | None = None  # a place id or name, as asked for
    place_ids: tuple[str, ...] | None = None  # filled only by resolve_place


def has_group_tables(conn) -> bool:
    """False for a v4 database, which has no places or same-route groups yet."""
    n = conn.execute(f"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN "
                     f"({', '.join('?' * len(GROUP_TABLES))})", GROUP_TABLES).fetchone()[0]
    return n == len(GROUP_TABLES)


# Letters NFD leaves whole, folded like the accented ones (casefold() already turns ß into ss).
_FOLDS = str.maketrans({"ł": "l", "ø": "o", "đ": "d"})


def fold_name(s: str) -> str:
    """Case and accents dropped, and ß, ł, ø, đ folded, as the site's normalizeName does
    (SQLite's lower() folds ASCII only)."""
    bare = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))
    return bare.casefold().translate(_FOLDS)


def resolve_place(conn, f: ActivityFilter) -> ActivityFilter:
    """Turn ``f.place`` into the ids of the places it names: the place with that id, else every place
    whose name matches with case and accents ignored."""
    if f.place is None:
        return f
    if not has_group_tables(conn):
        raise ValueError(NO_PLACES_YET)
    rows = conn.execute("SELECT id, name FROM places").fetchall()
    ids = [r[0] for r in rows if r[0] == f.place]
    if not ids:
        want = fold_name(f.place)
        ids = [r[0] for r in rows if fold_name(r[1]) == want]
    if not ids:
        raise ValueError(f"no place {f.place!r}; the places tool lists them")
    return dataclasses.replace(f, place_ids=tuple(sorted(ids)))


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
    if f.place is not None and f.place_ids is None:
        raise RuntimeError("place filter not resolved; call resolve_place first")
    if f.place_ids is not None:
        conds.append("a.id IN (SELECT activity_id FROM activity_groups WHERE place_id IN "
                     f"({', '.join('?' * len(f.place_ids))}))")
        params += list(f.place_ids)
        n = len(f.place_ids)
        rules.append(f"place: {f.place}" + (f" ({n} places with that name)" if n > 1 else ""))
        if f.include_hidden:
            # The refresh groups visible activities only, so a hidden one is never in a place.
            rules.append("place groups cover visible activities only")
    return (" AND ".join(conds) or "1"), params, rules
