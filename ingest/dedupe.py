from datetime import datetime

from . import store
from .model import Activity


def _merge(base: Activity, incoming: Activity, winner: str) -> Activity:
    """Keep base.id (canonical, stable). Fill both native ids. Apply policy."""
    strava_id = base.strava_id or incoming.strava_id
    garmin_id = base.garmin_id or incoming.garmin_id
    win_id_attr = "strava_id" if winner == "strava" else "garmin_id"
    if getattr(incoming, win_id_attr):
        meta = incoming
    elif getattr(base, win_id_attr):
        meta = base
    else:
        meta = incoming   # winner's source not present on either -> fresh incoming wins
    geo = incoming if len(incoming.polyline) > len(base.polyline) else base
    return Activity(
        id=base.id, strava_id=strava_id, garmin_id=garmin_id,
        name=meta.name, type=meta.type, start_time=meta.start_time,
        distance=meta.distance, moving_time=meta.moving_time,
        elevation_gain=meta.elevation_gain,
        polyline=geo.polyline, start_lat=geo.start_lat, start_lng=geo.start_lng,
    )


def reconcile(conn, incoming: Activity, *, window_s=180,
              name_stats_winner="strava") -> str:
    service = "strava" if incoming.strava_id else "garmin"
    sid = incoming.strava_id or incoming.garmin_id

    # 1. exact id-column match -> update in place
    existing = store.find_by_service_id(conn, service, sid)
    if existing:
        store.upsert(conn, _merge(existing, incoming, name_stats_winner))
        return "update"

    # 2. cross-source start-time match: pick the opposite-source candidate
    # closest in start_time (moving_time is not comparable across sources —
    # Strava/Garmin compute auto-pause differently).
    incoming_t = datetime.fromisoformat(incoming.start_time)
    best, best_delta = None, None
    for cand in store.find_near(conn, incoming.start_time, window_s):
        if getattr(cand, service + "_id"):
            continue  # same-source candidate already ruled out in step 1: distinct activity
        delta = abs((datetime.fromisoformat(cand.start_time) - incoming_t).total_seconds())
        if best is None or delta < best_delta:
            best, best_delta = cand, delta
    if best is not None:
        store.upsert(conn, _merge(best, incoming, name_stats_winner))
        return "merge"

    # 3. new
    store.upsert(conn, incoming)
    return "insert"
