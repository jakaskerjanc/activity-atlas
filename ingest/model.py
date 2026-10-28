from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .parse import ParsedFile


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


REPORTED_KEYS = ("avg_hr", "max_hr", "avg_cadence", "max_cadence", "avg_power", "max_power",
                 "elevation_gain_m", "elevation_loss_m", "calories", "aerobic_te", "anaerobic_te")


@dataclass
class SourceActivity:
    """One provider record normalized for the matcher and merge."""
    provider: str
    provider_activity_id: str
    name: str
    type: str                       # canonical (normalize.canonical_type)
    start_time: datetime            # tz-aware UTC
    elapsed_s: float | None
    moving_s: float | None
    distance_m: float | None
    utc_offset_s: int | None
    reported: dict[str, float | None]     # REPORTED_KEYS; provider summary first, then file summary
    hr_zones: dict | None
    gear: list[str]
    summary: dict                   # provider record verbatim
    file_sha256: str | None
    parsed: "ParsedFile | None"
    fetched_at: str
