from datetime import timezone
import fitdecode
from . import ParsedTrack

_SEMI = 180 / 2 ** 31


def parse_fit(fileobj, geometry: bool = True) -> ParsedTrack:
    """Parse a FIT stream. geometry=False reads only file_id (cheap classify)."""
    pts, start, created, sport, ftype = [], None, None, None, None
    with fitdecode.FitReader(fileobj) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name == "file_id":
                ftype = frame.get_value("type", fallback=None)
                created = frame.get_value("time_created", fallback=None)
                if not geometry:
                    break
            elif frame.name == "session":
                start = start or frame.get_value("start_time", fallback=None)
                sport = sport or frame.get_value("sport", fallback=None)
            elif frame.name == "record":
                la = frame.get_value("position_lat", fallback=None)
                lo = frame.get_value("position_long", fallback=None)
                if la is not None and lo is not None:
                    pts.append((la * _SEMI, lo * _SEMI))
    start = start or created
    if start is not None and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return ParsedTrack(track=pts, start_time=start, sport=sport, file_type=ftype)
