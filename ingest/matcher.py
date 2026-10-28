"""Assigns each incoming provider record to an activity.

1. Known record: (provider, provider_activity_id) exists -> update it in place.
2. Candidates: activities with no non-deleted source from the same provider
   whose [start - 180 s, end + 180 s] window intersects the record's range.
3. Score: when both ranges have positive length, accept when the overlap is
   ≥ 50% of the shorter range; otherwise accept when the starts are ≤ 180 s
   apart. Reject when both sides have GPS and distances differ by > 20%.
   The highest overlap ratio wins; ties go to the smallest start delta.
   A type mismatch warns but does not block.
4. No match: a new activity with a random 10-character ID.
"""
import secrets
import string
import warnings
from datetime import datetime, timedelta

from . import merge
from .model import SourceActivity

WINDOW_S = 180
MIN_OVERLAP = 0.5
MAX_DISTANCE_DIFF = 0.20

_ALPHABET = string.ascii_lowercase + string.digits


def new_activity_id(conn) -> str:
    while True:
        aid = "".join(secrets.choice(_ALPHABET) for _ in range(10))
        used = conn.execute(
            "SELECT 1 FROM activities WHERE id=? UNION ALL SELECT 1 FROM activity_sources WHERE activity_id=?",
            (aid, aid)).fetchone()
        if not used:
            return aid


def _has_gps(src: SourceActivity) -> bool:
    return bool(src.parsed is not None and src.parsed.track)


def _score(src: SourceActivity, s: datetime, e: datetime, cand) -> tuple[float, float] | None:
    """(overlap ratio, start delta) when the candidate is acceptable."""
    cs = datetime.fromisoformat(cand["start_time"])
    ce = datetime.fromisoformat(cand["end_time"])
    delta = abs((s - cs).total_seconds())
    length, clength = (e - s).total_seconds(), (ce - cs).total_seconds()
    if length > 0 and clength > 0:
        overlap = (min(e, ce) - max(s, cs)).total_seconds()
        ratio = overlap / min(length, clength)
        if ratio < MIN_OVERLAP:
            return None
    elif delta <= WINDOW_S:
        ratio = 0.0
    else:
        return None
    d1, d2 = src.distance_m, cand["distance"]
    if _has_gps(src) and cand["has_gps"] and d1 and d2 and d1 > 0 and d2 > 0:
        if abs(d1 - d2) / max(d1, d2) > MAX_DISTANCE_DIFF:
            return None
    return ratio, delta


def _find_match(conn, src: SourceActivity):
    s = src.start_time
    e = s + timedelta(seconds=src.elapsed_s or src.moving_s or 0)
    lo = merge.iso(s - timedelta(seconds=WINDOW_S))
    hi = merge.iso(e + timedelta(seconds=WINDOW_S))
    cands = conn.execute(
        "SELECT * FROM activities a WHERE a.start_time <= ? AND a.end_time >= ? "
        "AND NOT EXISTS (SELECT 1 FROM activity_sources x WHERE x.activity_id = a.id "
        "AND x.provider = ? AND x.deleted_at IS NULL)",
        (hi, lo, src.provider)).fetchall()
    best = None
    for cand in cands:
        sc = _score(src, s, e, cand)
        if sc is None:
            continue
        key = (-sc[0], sc[1], cand["id"])
        if best is None or key < best[0]:
            best = (key, cand)
    return best[1] if best else None


def _after(a: str, b: str) -> bool:
    return datetime.fromisoformat(a) > datetime.fromisoformat(b)


def reconcile(conn, src: SourceActivity, *, now: str) -> str:
    """Store one source record and recompute its activity.
    Returns "update" | "merge" | "insert"."""
    if src.parsed is not None and src.file_sha256:
        merge.write_file_data(conn, src.file_sha256, src.parsed)

    known = conn.execute(
        "SELECT activity_id, deleted_at FROM activity_sources WHERE provider=? AND provider_activity_id=?",
        (src.provider, src.provider_activity_id)).fetchone()
    if known is not None:
        merge.write_source(conn, src, known["activity_id"], now=now)
        if known["deleted_at"] and _after(src.fetched_at, known["deleted_at"]):
            conn.execute("UPDATE activity_sources SET deleted_at=NULL WHERE provider=? AND provider_activity_id=?",
                         (src.provider, src.provider_activity_id))
        merge.recompute_activity(conn, known["activity_id"])
        return "update"

    cand = _find_match(conn, src)
    if cand is not None:
        if cand["type"] and cand["type"] != src.type:
            warnings.warn(f"merging {src.provider}:{src.provider_activity_id} ({src.type}) "
                          f"into activity {cand['id']} ({cand['type']}): types differ")
        merge.write_source(conn, src, cand["id"], now=now)
        merge.recompute_activity(conn, cand["id"])
        return "merge"

    aid = new_activity_id(conn)
    merge.write_source(conn, src, aid, now=now)
    merge.recompute_activity(conn, aid)
    return "insert"
