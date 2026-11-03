"""Values we calculate from streams, used only to fill gaps the providers
left. Absent samples (None) are skipped; absent results are None, never 0."""
import math
from datetime import datetime
from zoneinfo import ZoneInfo

_EARTH_R = 6371008.8   # mean Earth radius, metres
_tf = None


def _durations(t: list[float | None]) -> list[float]:
    """Each sample lasts until the next timed sample; the last lasts 0.
    Untimed samples and backwards jumps (device resets) count 0."""
    out = [0.0] * len(t)
    nxt = None
    for i in range(len(t) - 1, -1, -1):
        if t[i] is None:
            continue
        if nxt is not None:
            out[i] = max(0.0, nxt - t[i])
        nxt = t[i]
    return out


def time_weighted_mean(t: list[float | None], v: list[float | None]) -> float | None:
    num = den = 0.0
    for d, x in zip(_durations(t), v):
        if x is not None and d > 0:
            num += x * d
            den += d
    return num / den if den else None


def series_max(v: list[float | None]) -> float | None:
    vals = [x for x in v if x is not None]
    return max(vals) if vals else None


def elevation_gain_loss(alt: list[float | None], threshold_m: float = 2.0) -> tuple[float, float]:
    """Hysteresis: a change counts once it moves ≥ threshold from the last
    counted altitude."""
    gain = loss = 0.0
    ref = None
    for a in alt:
        if a is None:
            continue
        if ref is None:
            ref = a
        elif a - ref >= threshold_m:
            gain += a - ref
            ref = a
        elif ref - a >= threshold_m:
            loss += ref - a
            ref = a
    return gain, loss


def time_in_zones(t: list[float | None], hr: list[float | None], limits: list[int]) -> list[float]:
    """Seconds per zone, len(limits) + 1 values. A sample is in zone i for the
    first i with hr < limits[i], otherwise in zone len(limits)."""
    out = [0.0] * (len(limits) + 1)
    for d, h in zip(_durations(t), hr):
        if h is None:
            continue
        zone = next((i for i, lim in enumerate(limits) if h < lim), len(limits))
        out[zone] += d
    return out


def _haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * _EARTH_R * math.asin(math.sqrt(h))


def cumulative_distance(lat: list[float | None], lon: list[float | None]) -> list[float | None]:
    """Haversine metres from the first fix; None where a sample has no fix."""
    out, total, prev = [], 0.0, None
    for a, b in zip(lat, lon):
        if a is None or b is None:
            out.append(None)
            continue
        if prev is not None:
            total += _haversine(prev, (a, b))
        prev = (a, b)
        out.append(total)
    return out


def bbox(lat, lon) -> tuple[float, float, float, float] | None:
    """(min_lat, min_lng, max_lat, max_lng) over samples with a fix."""
    pts = [(a, b) for a, b in zip(lat, lon) if a is not None and b is not None]
    if not pts:
        return None
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    return min(lats), min(lons), max(lats), max(lons)


def local_offset_s(lat: float, lon: float, when_utc: datetime) -> int | None:
    """UTC offset of the time zone at (lat, lon) at that instant."""
    global _tf
    if _tf is None:
        from timezonefinder import TimezoneFinder
        _tf = TimezoneFinder()
    name = _tf.timezone_at(lat=lat, lng=lon)
    if name is None:
        return None
    off = when_utc.astimezone(ZoneInfo(name)).utcoffset()
    return int(off.total_seconds()) if off is not None else None
