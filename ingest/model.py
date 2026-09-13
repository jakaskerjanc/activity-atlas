from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class RawActivity:
    """Source-agnostic intermediate emitted by every import/fetch component."""
    source: str                 # "strava" | "garmin"
    source_id: str
    name: str
    type_raw: str               # the source's own type key, pre-normalization
    start_time: datetime        # tz-aware UTC
    distance_m: float
    moving_time_s: int
    elevation_gain_m: float
    track: list[tuple[float, float]] = field(default_factory=list)  # (lat, lon) degrees
    source_file: str | None = None


@dataclass
class Activity:
    """The stored row. Canonical id prefix is the source; both native ids kept."""
    id: str
    strava_id: str | None
    garmin_id: str | None
    name: str
    type: str
    start_time: str             # ISO-8601 UTC
    distance: float             # meters
    moving_time: int            # seconds
    elevation_gain: float       # meters
    polyline: str               # precision-5; "" = no GPS
    start_lat: float | None
    start_lng: float | None
