"""Writes provider sources and per-file data, and recomputes an activity's
display values from its stored sources.

Merge policy: Strava first, Garmin second, for every value. A
provider-reported number beats our calculation; calculations only fill gaps
and are listed in `activities.calculated`. Absent stays NULL. Deleted
sources never win unless every source is deleted (then visible = 0).
"""
import json
from datetime import datetime, timedelta, timezone

from . import calc, codec
from .model import REPORTED_KEYS, SourceActivity
from .normalize import encode, simplify
from .parse import ParsedFile

PROVIDER_ORDER = ("strava", "garmin")

_URLS = {"strava": "https://www.strava.com/activities/{}",
         "garmin": "https://connect.garmin.com/modern/activity/{}"}

_LAP_COLS = ("start_time", "elapsed_s", "moving_s", "distance_m", "avg_hr", "max_hr", "avg_speed",
             "elevation_gain_m", "elevation_loss_m", "avg_cadence", "avg_power", "trigger")

# reported key -> activities column (elevation_gain_m -> elevation_gain)
_REPORTED_COL = {k: k[:-2] if k.endswith("_m") else k for k in REPORTED_KEYS}

# gap fills from streams: column -> (kind, channel)
_FILL = (("avg_hr", "mean", "hr"), ("max_hr", "max", "hr"),
         ("avg_cadence", "mean", "cadence"), ("max_cadence", "max", "cadence"),
         ("avg_power", "mean", "power"), ("max_power", "max", "power"))


def source_url(provider: str, provider_activity_id: str) -> str:
    return _URLS[provider].format(provider_activity_id)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _end(start: datetime, elapsed, moving) -> datetime:
    return start + timedelta(seconds=elapsed or moving or 0)


def write_file_data(conn, file_sha256: str, parsed: ParsedFile) -> None:
    """Streams and laps for one activity file; a no-op if already stored.
    A missing distance channel is filled from positions."""
    if conn.execute("SELECT 1 FROM streams WHERE file_sha256=?", (file_sha256,)).fetchone():
        return
    streams = dict(parsed.streams)
    calculated = 0
    if "distance" not in streams and "lat" in streams and "lon" in streams:
        streams["distance"] = calc.cumulative_distance(streams["lat"], streams["lon"])
        calculated = 1
    count = max((len(v) for v in streams.values()), default=0)
    cols = ["file_sha256", "sample_count", "encoding", "distance_calculated", *streams]
    vals = [file_sha256, count, codec.ENCODING_VERSION, calculated,
            *(codec.encode(ch, v) for ch, v in streams.items())]
    conn.execute(f"INSERT INTO streams ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
    for lap in parsed.laps:
        conn.execute(
            f"INSERT OR REPLACE INTO laps (file_sha256, lap_index, {','.join(_LAP_COLS)}) "
            f"VALUES ({','.join('?' * (len(_LAP_COLS) + 2))})",
            (file_sha256, lap["index"], *(lap.get(c) for c in _LAP_COLS)))


def write_source(conn, src: SourceActivity, activity_id: str, *, now: str) -> None:
    """Insert a source row, or rewrite the derived columns of an existing one.
    Identity columns (activity_id, pinned, deleted_at) of an existing row are
    left alone; the matcher owns them."""
    derived = {
        "url": source_url(src.provider, src.provider_activity_id),
        "name": src.name,
        "type": src.type,
        "start_time": iso(src.start_time),
        "end_time": iso(_end(src.start_time, src.elapsed_s, src.moving_s)),
        "elapsed_time": src.elapsed_s,
        "moving_time": src.moving_s,
        "distance": src.distance_m,
        "utc_offset_s": src.utc_offset_s,
        "reported": json.dumps({k: src.reported.get(k) for k in REPORTED_KEYS}),
        "hr_zones": json.dumps(src.hr_zones) if src.hr_zones else None,
        "file_sha256": src.file_sha256,
        "gear": json.dumps(src.gear),
        "summary_json": json.dumps(src.summary, sort_keys=True, ensure_ascii=False),
        "fetched_at": src.fetched_at,
        "updated_at": now,
    }
    cols = ["provider", "provider_activity_id", "activity_id", "first_seen", *derived]
    conn.execute(
        f"INSERT INTO activity_sources ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
        "ON CONFLICT(provider, provider_activity_id) DO UPDATE SET "
        + ", ".join(f"{c}=excluded.{c}" for c in derived),
        (src.provider, src.provider_activity_id, activity_id, now, *derived.values()))


def _ordered_sources(conn, activity_id: str):
    rows = conn.execute("SELECT * FROM activity_sources WHERE activity_id=?", (activity_id,)).fetchall()
    rank = {p: i for i, p in enumerate(PROVIDER_ORDER)}
    return sorted(rows, key=lambda r: (rank.get(r["provider"], len(rank)), r["provider"],
                                       r["provider_activity_id"]))


def _first(rows, get):
    for r in rows:
        v = get(r)
        if v is not None:
            return v
    return None


def _load_streams(conn, rows):
    for r in rows:
        if not r["file_sha256"]:
            continue
        s = conn.execute("SELECT * FROM streams WHERE file_sha256=? AND sample_count > 0",
                         (r["file_sha256"],)).fetchone()
        if s is not None:
            return s["file_sha256"], {ch: codec.decode(ch, s[ch]) for ch in codec.CHANNEL_SCALES
                                      if s[ch] is not None}
    return None, {}


def _closest_zone_limits(conn, start_time: str):
    """hr_zone_limits from the source with zones whose start is closest."""
    t = datetime.fromisoformat(start_time)
    best = None
    for r in conn.execute("SELECT provider, provider_activity_id, start_time, hr_zones FROM activity_sources "
                          "WHERE hr_zones IS NOT NULL"):
        delta = abs((datetime.fromisoformat(r["start_time"]) - t).total_seconds())
        key = (delta, r["provider"], r["provider_activity_id"])
        if best is None or key < best[0]:
            best = (key, json.loads(r["hr_zones"])["limits"])
    return best[1] if best else None


def recompute_activity(conn, activity_id: str) -> None:
    """Recompute one activity's display values from its stored sources
    (upserting the activities row)."""
    all_rows = _ordered_sources(conn, activity_id)
    if not all_rows:
        return
    rows = [r for r in all_rows if r["deleted_at"] is None]
    has_live = bool(rows)
    rows = rows or all_rows
    reported = [json.loads(r["reported"] or "{}") for r in rows]
    zones = _first(rows, lambda r: json.loads(r["hr_zones"]) if r["hr_zones"] else None)

    a = {
        "id": activity_id,
        "name": _first(rows, lambda r: r["name"]),
        "type": _first(rows, lambda r: r["type"]),
        "start_time": _first(rows, lambda r: r["start_time"]),
        "elapsed_time": _first(rows, lambda r: r["elapsed_time"]),
        "moving_time": _first(rows, lambda r: r["moving_time"]),
        "distance": _first(rows, lambda r: r["distance"]),
        "utc_offset_s": _first(rows, lambda r: r["utc_offset_s"]),
        "hr_zone_seconds": zones["seconds"] if zones else None,
        "hr_zone_limits": zones["limits"] if zones else None,
        "meta_provider": rows[0]["provider"],
    }
    for key, col in _REPORTED_COL.items():
        a[col] = _first(reported, lambda rep: rep.get(key))

    calculated = []
    sha, st = _load_streams(conn, rows)
    t = st.get("time", [])
    lat, lon = st.get("lat", []), st.get("lon", [])
    for col, kind, ch in _FILL:
        if a[col] is None and ch in st:
            a[col] = calc.time_weighted_mean(t, st[ch]) if kind == "mean" else calc.series_max(st[ch])
            if a[col] is not None:
                calculated.append(col)
    if "altitude" in st and (a["elevation_gain"] is None or a["elevation_loss"] is None):
        gain, loss = calc.elevation_gain_loss(st["altitude"])
        for col, v in (("elevation_gain", gain), ("elevation_loss", loss)):
            if a[col] is None:
                a[col] = v
                calculated.append(col)
    if a["hr_zone_seconds"] is None and "hr" in st and t:
        limits = _closest_zone_limits(conn, a["start_time"])
        if limits:
            a["hr_zone_seconds"] = calc.time_in_zones(t, st["hr"], limits)
            a["hr_zone_limits"] = limits
            calculated.append("hr_zone_seconds")
    fix = next(((x, y) for x, y in zip(lat, lon) if x is not None and y is not None), None)
    start = datetime.fromisoformat(a["start_time"])
    if a["utc_offset_s"] is None and fix is not None:
        a["utc_offset_s"] = calc.local_offset_s(fix[0], fix[1], start)
        if a["utc_offset_s"] is not None:
            calculated.append("utc_offset_s")
    if a["distance"] is None and "distance" in st:
        a["distance"] = _first(reversed(st["distance"]), lambda v: v)
        if a["distance"] is not None:
            calculated.append("distance")

    track = [(x, y) for x, y in zip(lat, lon) if x is not None and y is not None]
    box = calc.bbox(lat, lon)
    hidden = conn.execute("SELECT hidden FROM activity_overrides WHERE activity_id=?",
                          (activity_id,)).fetchone()
    a.update({
        "end_time": iso(_end(start, a["elapsed_time"], a["moving_time"])),
        "start_local": (start + timedelta(seconds=a["utc_offset_s"])).replace(tzinfo=None).isoformat()
                       if a["utc_offset_s"] is not None else None,
        "polyline": encode(simplify(track, 0.5)) if track else "",
        "start_lat": track[0][0] if track else None,
        "start_lng": track[0][1] if track else None,
        "min_lat": box[0] if box else None, "min_lng": box[1] if box else None,
        "max_lat": box[2] if box else None, "max_lng": box[3] if box else None,
        "has_gps": int(bool(track)),
        "has_hr": int("hr" in st), "has_altitude": int("altitude" in st),
        "has_cadence": int("cadence" in st), "has_power": int("power" in st),
        "streams_sha256": sha,
        "calculated": json.dumps(calculated),
        "visible": int(has_live and not (hidden and hidden["hidden"])),
    })
    for col in ("hr_zone_seconds", "hr_zone_limits"):
        a[col] = json.dumps(a[col]) if a[col] is not None else None

    cols = list(a)
    conn.execute(
        f"INSERT INTO activities ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
        "ON CONFLICT(id) DO UPDATE SET " + ", ".join(f"{c}=excluded.{c}" for c in cols if c != "id"),
        [a[c] for c in cols])

    conn.execute("DELETE FROM activity_gear WHERE activity_id=?", (activity_id,))
    for r in rows:
        for g in json.loads(r["gear"] or "[]"):
            conn.execute("INSERT OR IGNORE INTO gear (provider, name) VALUES (?, ?)", (r["provider"], g))
            conn.execute("INSERT OR IGNORE INTO activity_gear (activity_id, provider, gear_name) VALUES (?, ?, ?)",
                         (activity_id, r["provider"], g))
