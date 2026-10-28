import xml.etree.ElementTree as ET
from datetime import datetime
from . import ParsedFile, columns, summary

_NS = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2",
       "x": "http://www.garmin.com/xmlschemas/ActivityExtension/v2"}


def _time(s):
    return datetime.fromisoformat(s.strip().replace("Z", "+00:00")) if s and s.strip() else None


def _num(el, path):
    node = el.find(path, _NS)
    if node is None or node.text is None or not node.text.strip():
        return None
    return float(node.text)


def _trackpoint(tp) -> dict | None:
    t = _time(tp.findtext("t:Time", default=None, namespaces=_NS))
    if t is None:
        return None
    lat = _num(tp, "t:Position/t:LatitudeDegrees")
    lon = _num(tp, "t:Position/t:LongitudeDegrees")
    if lat is None or lon is None:
        lat = lon = None
    return {
        "time": t, "lat": lat, "lon": lon,
        "altitude": _num(tp, "t:AltitudeMeters"),
        "distance": _num(tp, "t:DistanceMeters"),
        "hr": _num(tp, "t:HeartRateBpm/t:Value"),
        "cadence": _num(tp, "t:Cadence"),
        "speed": _num(tp, "t:Extensions/x:TPX/x:Speed"),
        "power": _num(tp, "t:Extensions/x:TPX/x:Watts"),
    }


def _lap(lap, index: int) -> dict:
    st = _time(lap.get("StartTime"))
    return {
        "index": index,
        "start_time": st.isoformat() if st else None,
        "elapsed_s": _num(lap, "t:TotalTimeSeconds"),
        "moving_s": None,
        "distance_m": _num(lap, "t:DistanceMeters"),
        "avg_hr": _num(lap, "t:AverageHeartRateBpm/t:Value"),
        "max_hr": _num(lap, "t:MaximumHeartRateBpm/t:Value"),
        "avg_speed": _num(lap, "t:Extensions/x:LX/x:AvgSpeed"),
        "elevation_gain_m": None,
        "elevation_loss_m": None,
        "avg_cadence": _num(lap, "t:Cadence"),
        "avg_power": _num(lap, "t:Extensions/x:LX/x:AvgWatts"),
        "trigger": lap.findtext("t:TriggerMethod", default=None, namespaces=_NS),
    }


def _sum(laps, key):
    vals = [l[key] for l in laps if l[key] is not None]
    return sum(vals) if vals else None


def _lap_summary(laps, calories):
    weighted = [(l["avg_hr"], l["elapsed_s"]) for l in laps
                if l["avg_hr"] is not None and l["elapsed_s"]]
    total_w = sum(w for _, w in weighted)
    max_hrs = [l["max_hr"] for l in laps if l["max_hr"] is not None]
    return summary(
        elapsed_s=_sum(laps, "elapsed_s"),
        distance_m=_sum(laps, "distance_m"),
        calories=sum(calories) if calories else None,
        avg_hr=sum(v * w for v, w in weighted) / total_w if total_w else None,
        max_hr=max(max_hrs) if max_hrs else None,
    )


def parse_tcx(fileobj) -> ParsedFile:
    data = fileobj.read()
    if isinstance(data, str):
        data = data.encode("utf-8")
    if data[:3] == b"\xef\xbb\xbf":            # strip UTF-8 BOM
        data = data[3:]
    root = ET.fromstring(data.lstrip())        # tolerate leading whitespace before <?xml
    samples = [s for s in (_trackpoint(tp) for tp in root.iterfind(".//t:Trackpoint", _NS))
               if s is not None]
    lap_els = list(root.iterfind(".//t:Lap", _NS))
    laps = [_lap(l, i) for i, l in enumerate(lap_els)]
    calories = [c for c in (_num(l, "t:Calories") for l in lap_els) if c is not None]
    start = laps[0]["start_time"] if laps else None
    start = _time(start) if start else (samples[0]["time"] if samples else None)
    sport = root.find(".//t:Activity", _NS)
    return ParsedFile(
        sport=sport.get("Sport") if sport is not None else None,
        start_time=start,
        streams=columns(samples, start),
        summary=_lap_summary(laps, calories),
        laps=laps,
    )
