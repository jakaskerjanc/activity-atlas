from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .parse import ParsedFile


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
    observed_at: str | None = None  # earliest moment the data may have been observed; None = fetched_at
