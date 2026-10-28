from datetime import timezone

import gpxpy
from . import ParsedFile, columns, summary

_EXT = {"hr": "hr", "cad": "cadence", "atemp": "temperature", "power": "power"}


def _extensions(point) -> dict:
    out = {}
    for ext in point.extensions:
        for el in ext.iter():
            key = _EXT.get(el.tag.rsplit("}", 1)[-1])
            if key and el.text and el.text.strip():
                try:
                    out[key] = float(el.text)
                except ValueError:
                    pass
    return out


def parse_gpx(fileobj) -> ParsedFile:
    gpx = gpxpy.parse(fileobj)
    samples = []
    for trk in gpx.tracks:
        for seg in trk.segments:
            for p in seg.points:
                samples.append({"time": p.time, "lat": p.latitude, "lon": p.longitude,
                                "altitude": p.elevation, **_extensions(p)})
    start = next((s["time"] for s in samples if s["time"] is not None), None)
    start = start.astimezone(timezone.utc) if start is not None else None
    return ParsedFile(start_time=start, streams=columns(samples, start), summary=summary())
