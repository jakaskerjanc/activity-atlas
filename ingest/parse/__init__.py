from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ParsedTrack:
    track: list[tuple[float, float]] = field(default_factory=list)  # (lat, lon)
    start_time: datetime | None = None
    sport: str | None = None
    file_type: str | None = None   # FIT file_id.type; None for gpx/tcx
