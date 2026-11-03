from dataclasses import dataclass, field
from datetime import datetime, timezone
import io
import fitdecode

MONITORING_FILE_TYPES = ("monitoring_a", "monitoring_b", "monitoring_daily")

FIT_EPOCH = 631065600            # 1989-12-31T00:00:00Z


@dataclass
class MonitoringData:
    utc_offset_s: int | None                    # monitoring_info local_timestamp - timestamp
    # "hr" | "stress" | "respiration" -> [(unix_s, value)] in time order
    series: dict[str, list[tuple[int, float]]] = field(default_factory=dict)
    # local date -> {"resting_heart_rate": .., "current_day_resting_heart_rate": ..}
    resting: dict[str, dict] = field(default_factory=dict)
    resting_at: dict[str, int] = field(default_factory=dict)   # local date -> unix_s of that reading


def _unix(dt) -> int:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def parse_monitoring(data: bytes) -> MonitoringData:
    """Parse a monitoring FIT into all-day HR, stress and respiration series.
    Messages are read in file order; negative stress/respiration and zero HR
    (no reading) are dropped."""
    series = {"hr": [], "stress": [], "respiration": []}
    offset, last, resting_at = None, None, []
    with fitdecode.FitReader(io.BytesIO(data)) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            ts = frame.get_value("timestamp", fallback=None)
            if ts is not None:
                last = _unix(ts) - FIT_EPOCH
            name = frame.name
            if name == "monitoring_info":
                local = frame.get_value("local_timestamp", fallback=None)
                if ts is not None and local is not None:
                    offset = _unix(local) - _unix(ts)
            elif name == "monitoring":
                hr = frame.get_value("heart_rate", fallback=None)
                ts16 = frame.get_value("timestamp_16", fallback=None)
                if hr and ts16 is not None and last is not None:
                    # timestamp_16 is the low 16 bits of the FIT time; the next
                    # instant at or after the last full timestamp with those bits
                    t = last + ((ts16 - last) & 0xFFFF)
                    series["hr"].append((t + FIT_EPOCH, hr))
            elif name == "stress_level":
                v = frame.get_value("stress_level_value", fallback=None)
                t = frame.get_value("stress_level_time", fallback=None)
                if v is not None and v >= 0 and t is not None:
                    series["stress"].append((_unix(t), v))
            elif name == "respiration_rate":
                v = frame.get_value("respiration_rate", fallback=None)
                if v is not None and v >= 0 and ts is not None:
                    series["respiration"].append((_unix(ts), v))
            elif name == "monitoring_hr_data" and ts is not None:
                resting_at.append((_unix(ts), {
                    "resting_heart_rate": frame.get_value("resting_heart_rate", fallback=None),
                    "current_day_resting_heart_rate":
                        frame.get_value("current_day_resting_heart_rate", fallback=None)}))
    # the offset may arrive after a resting message, so key the dates once it is known
    resting, resting_s = {}, {}
    for t, values in resting_at:
        day = datetime.fromtimestamp(t + (offset or 0), timezone.utc).date().isoformat()
        resting[day], resting_s[day] = values, t
    return MonitoringData(offset, series, resting, resting_s)
