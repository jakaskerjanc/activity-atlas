import gpxpy
from . import ParsedTrack


def parse_gpx(fileobj) -> ParsedTrack:
    gpx = gpxpy.parse(fileobj)
    pts, start = [], None
    for trk in gpx.tracks:
        for seg in trk.segments:
            for p in seg.points:
                pts.append((p.latitude, p.longitude))
                if start is None and p.time is not None:
                    start = p.time
    return ParsedTrack(track=pts, start_time=start)
