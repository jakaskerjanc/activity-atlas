"""Decoded, downsampled samples: one activity's streams, one day's wellness series."""
import math

from ingest import codec

from .activities import counted
from .database import Database

DEFAULT_MAX_POINTS = 500
HARD_MAX_POINTS = 2000

STREAM_CHANNELS = [c for c in codec.CHANNEL_SCALES if c != "time"]
UNITS = {
    "lat": "deg", "lon": "deg", "altitude": "m", "hr": "bpm", "cadence": "rpm or spm", "speed": "m/s",
    "distance": "m", "power": "W", "temperature": "°C", "stress": "0-100", "respiration": "breaths/min",
    "hrv": "ms",
}


def bucket_average(times: list[float], channels: dict[str, list[float | None]],
                   every_s: float) -> tuple[list[float], dict[str, list[float | None]]]:
    """Mean of the present values per bucket of ``every_s`` seconds, counted from
    the first sample. Buckets with no samples at all are left out; a bucket whose
    samples are all missing gives None."""
    if not times:
        return [], {k: [] for k in channels}
    t0 = times[0]
    order: list[int] = []
    sums: dict[int, dict[str, list[float]]] = {}
    for i, t in enumerate(times):
        if t is None:
            continue
        k = int((t - t0) // every_s)
        if k not in sums:
            order.append(k)
            sums[k] = {c: [] for c in channels}
        for c, values in channels.items():
            v = values[i]
            if v is not None:
                sums[k][c].append(v)
    starts = [t0 + k * every_s for k in order]
    out = {c: [sum(sums[k][c]) / len(sums[k][c]) if sums[k][c] else None for k in order] for c in channels}
    return starts, out


def _every(times: list[float], every_s: float | None, max_points: int) -> float:
    """The bucket width: the caller's ``every_s``, but never so small that the
    result would exceed ``max_points`` rows."""
    if every_s is not None and every_s <= 0:
        raise ValueError("every_s must be positive")
    span = (times[-1] - times[0]) if times else 0
    floor = max(1, math.ceil((span + 1) / max_points))
    return max(every_s or 0, floor)


def _round(channel: str, v: float | None):
    if v is None:
        return None
    return round(v, 6 if channel in ("lat", "lon") else 2)


def _cap(max_points: int) -> int:
    return max(1, min(max_points, HARD_MAX_POINTS))


def activity_samples(db: Database, activity_id: str, channels: list[str] | None = None,
                     every_s: float | None = None, max_points: int = DEFAULT_MAX_POINTS) -> dict:
    a = db.conn.execute("SELECT streams_sha256 FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if a is None:
        raise ValueError(f"no activity {activity_id}")
    for c in channels or []:
        if c not in STREAM_CHANNELS:
            raise ValueError(f"unknown channel {c}; channels: {', '.join(STREAM_CHANNELS)}")
    s = db.conn.execute("SELECT * FROM streams WHERE file_sha256 = ?", (a["streams_sha256"],)).fetchone() \
        if a["streams_sha256"] else None
    if s is None or s["time"] is None:
        return {"data": {"columns": [], "rows": [], "units": {}},
                "counted": counted([], 0, {"no samples stored": 1})}
    wanted = channels or [c for c in STREAM_CHANNELS if s[c] is not None]
    missing = [c for c in wanted if s[c] is None]
    present = [c for c in wanted if s[c] is not None]
    times = codec.decode("time", s["time"])
    every = _every(times, every_s, _cap(max_points))
    starts, avg = bucket_average(times, {c: codec.decode(c, s[c]) for c in present}, every)
    rows = [[round(t)] + [_round(c, avg[c][i]) for c in present] for i, t in enumerate(starts)]
    rules = [f"averaged into {every:g} s buckets from the activity start"]
    if missing:
        rules.append("not recorded: " + ", ".join(missing))
    return {
        "data": {"every_s": every, "columns": ["t_s", *present], "rows": rows,
                 "units": {"t_s": "s from start", **{c: UNITS[c] for c in present}}},
        "counted": counted(rules, len(times)),
    }


def wellness_series(db: Database, date: str, channel: str, every_s: float | None = None,
                    max_points: int = DEFAULT_MAX_POINTS) -> dict:
    channels = [r[0] for r in db.conn.execute("SELECT DISTINCT channel FROM daily_series ORDER BY channel")]
    if channel not in channels:
        raise ValueError(f"unknown channel {channel}; channels: {', '.join(channels)}")
    first, last = db.conn.execute(
        "SELECT min(date), max(date) FROM daily_series WHERE channel = ?", (channel,)).fetchone()
    coverage = {"first": first, "last": last}
    r = db.conn.execute("SELECT time, data FROM daily_series WHERE date = ? AND channel = ?",
                        (date, channel)).fetchone()
    if r is None:
        return {"data": {"columns": ["local_time", channel], "rows": [], "coverage": coverage},
                "counted": counted([f"no {channel} series stored for {date}"], 0)}
    times = codec.decode("time", r["time"])
    every = _every(times, every_s, _cap(max_points))
    starts, avg = bucket_average(times, {channel: codec.decode(channel, r["data"])}, every)
    rows = [[f"{int(t) // 3600:02d}:{int(t) % 3600 // 60:02d}", _round(channel, avg[channel][i])]
            for i, t in enumerate(starts)]
    return {
        "data": {"every_s": every, "columns": ["local_time", channel], "rows": rows,
                 "unit": UNITS.get(channel), "coverage": coverage},
        "counted": counted([f"averaged into {every:g} s buckets", "times are local clock time"], len(times)),
    }
