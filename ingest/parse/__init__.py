from dataclasses import dataclass, field
from datetime import datetime

from ..codec import CHANNEL_SCALES

SUMMARY_KEYS = ("elapsed_s", "moving_s", "distance_m", "avg_hr", "max_hr", "avg_cadence",
                "max_cadence", "avg_power", "max_power", "elevation_gain_m", "elevation_loss_m",
                "calories", "aerobic_te", "anaerobic_te")


@dataclass
class ParsedFile:
    file_type: str | None = None          # FIT file_id.type; None for gpx/tcx
    sport: str | None = None
    sub_sport: str | None = None
    start_time: datetime | None = None    # tz-aware UTC
    utc_offset_s: int | None = None
    # keys ⊆ CHANNEL_SCALES; "time" = s since start_time; all lists equal length
    streams: dict[str, list[float | None]] = field(default_factory=dict)
    summary: dict[str, float | None] = field(default_factory=dict)   # SUMMARY_KEYS
    # keys: index, start_time (ISO UTC), elapsed_s, moving_s, distance_m, avg_hr, max_hr,
    # avg_speed, elevation_gain_m, elevation_loss_m, avg_cadence, avg_power, trigger
    laps: list[dict] = field(default_factory=list)
    hr_zones: dict | None = None          # {"seconds": list[float], "limits": list[int]}

    @property
    def track(self) -> list[tuple[float, float]]:
        lat, lon = self.streams.get("lat", []), self.streams.get("lon", [])
        return [(a, b) for a, b in zip(lat, lon) if a is not None and b is not None]


ParsedTrack = ParsedFile   # existing imports keep working


def columns(samples: list[dict], start: datetime | None) -> dict[str, list[float | None]]:
    """Turn per-sample dicts (with a datetime "time" or none) into equal-length
    channel lists. "time" becomes seconds since `start`; channels with no
    values at all are dropped."""
    out = {}
    for ch in CHANNEL_SCALES:
        if ch == "time":
            col = [(s["time"] - start).total_seconds() if s.get("time") is not None and start else None
                   for s in samples]
        else:
            col = [s.get(ch) for s in samples]
        if any(v is not None for v in col):
            out[ch] = col
    return out


def summary(**values) -> dict[str, float | None]:
    return {k: values.get(k) for k in SUMMARY_KEYS}
