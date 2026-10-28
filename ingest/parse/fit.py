from datetime import timezone
import fitdecode
from . import ParsedFile, columns, summary

_SEMI = 180 / 2 ** 31

_SESSION = {"elapsed_s": "total_elapsed_time", "moving_s": "total_timer_time",
            "distance_m": "total_distance", "avg_hr": "avg_heart_rate",
            "max_hr": "max_heart_rate", "avg_cadence": "avg_cadence",
            "max_cadence": "max_cadence", "avg_power": "avg_power", "max_power": "max_power",
            "elevation_gain_m": "total_ascent", "elevation_loss_m": "total_descent",
            "calories": "total_calories", "aerobic_te": "total_training_effect",
            "anaerobic_te": "total_anaerobic_training_effect"}


def _utc(dt):
    if dt is not None and dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _first(msg, *names):
    for n in names:
        v = msg.get_value(n, fallback=None)
        if v is not None:
            return v
    return None


def _record(msg) -> dict | None:
    ts = msg.get_value("timestamp", fallback=None)
    if ts is None:
        return None
    la = msg.get_value("position_lat", fallback=None)
    lo = msg.get_value("position_long", fallback=None)
    return {
        "time": _utc(ts),
        "lat": la * _SEMI if la is not None and lo is not None else None,
        "lon": lo * _SEMI if la is not None and lo is not None else None,
        "altitude": _first(msg, "enhanced_altitude", "altitude"),
        "hr": msg.get_value("heart_rate", fallback=None),
        "cadence": msg.get_value("cadence", fallback=None),
        "speed": _first(msg, "enhanced_speed", "speed"),
        "distance": msg.get_value("distance", fallback=None),
        "power": msg.get_value("power", fallback=None),
        "temperature": msg.get_value("temperature", fallback=None),
    }


def _lap(msg, index: int) -> dict:
    st = _utc(msg.get_value("start_time", fallback=None))
    return {
        "index": index,
        "start_time": st.isoformat() if st else None,
        "elapsed_s": msg.get_value("total_elapsed_time", fallback=None),
        "moving_s": msg.get_value("total_timer_time", fallback=None),
        "distance_m": msg.get_value("total_distance", fallback=None),
        "avg_hr": msg.get_value("avg_heart_rate", fallback=None),
        "max_hr": msg.get_value("max_heart_rate", fallback=None),
        "avg_speed": _first(msg, "enhanced_avg_speed", "avg_speed"),
        "elevation_gain_m": msg.get_value("total_ascent", fallback=None),
        "elevation_loss_m": msg.get_value("total_descent", fallback=None),
        "avg_cadence": msg.get_value("avg_cadence", fallback=None),
        "avg_power": msg.get_value("avg_power", fallback=None),
        "trigger": msg.get_value("lap_trigger", fallback=None),
    }


def parse_fit(fileobj, geometry: bool = True) -> ParsedFile:
    """Parse a FIT stream. geometry=False reads only file_id (cheap classify).
    Records without a timestamp are skipped; the rest keep file order."""
    p = ParsedFile()
    samples, created, session = [], None, None
    with fitdecode.FitReader(fileobj) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            name = frame.name
            if name == "file_id":
                p.file_type = frame.get_value("type", fallback=None)
                created = frame.get_value("time_created", fallback=None)
                if not geometry:
                    break
            elif name == "record":
                rec = _record(frame)
                if rec is not None:
                    samples.append(rec)
            elif name == "session" and session is None:
                session = frame
            elif name == "lap":
                p.laps.append(_lap(frame, len(p.laps)))
            elif name == "time_in_zone" and p.hr_zones is None \
                    and frame.get_value("reference_mesg", fallback=None) == "session":
                secs = frame.get_value("time_in_hr_zone", fallback=None)
                limits = frame.get_value("hr_zone_high_boundary", fallback=None)
                if secs and limits:
                    p.hr_zones = {"seconds": [float(s) for s in secs if s is not None],
                                  "limits": [int(x) for x in limits if x is not None]}
            elif name == "activity":
                ts = frame.get_value("timestamp", fallback=None)
                local = frame.get_value("local_timestamp", fallback=None)
                if ts is not None and local is not None:
                    p.utc_offset_s = round((_utc(local) - _utc(ts)).total_seconds())
    if session is not None:
        p.start_time = _utc(session.get_value("start_time", fallback=None))
        p.sport = session.get_value("sport", fallback=None)
        p.sub_sport = session.get_value("sub_sport", fallback=None)
        p.summary = summary(**{k: session.get_value(f, fallback=None) for k, f in _SESSION.items()})
    else:
        p.summary = summary()
    p.start_time = p.start_time or _utc(created)
    if not geometry:
        return p
    if p.start_time is None and samples:
        p.start_time = samples[0]["time"]
    p.streams = columns(samples, p.start_time)
    return p
