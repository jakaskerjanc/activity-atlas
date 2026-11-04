"""Shared builders for the v2 engine tests."""
import json
import os
from datetime import date, datetime, timedelta, timezone

from ingest import db
from ingest.model import REPORTED_KEYS, SourceActivity
from ingest.parse.fit import parse_fit

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
NOW = "2026-10-27T12:00:00+00:00"
FETCHED = "2026-10-27T10:00:00+00:00"


def fixture_bytes(name: str) -> bytes:
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def outdoor():
    with open(os.path.join(FIX, "outdoor.fit"), "rb") as f:
        return parse_fit(f)


def at(hms: str, day: str = "2026-08-01") -> datetime:
    """'06:00' or '06:30:15' on `day`, UTC."""
    if hms.count(":") == 1:
        hms += ":00"
    return datetime.fromisoformat(f"{day}T{hms}+00:00").astimezone(timezone.utc)


def fresh():
    conn = db.connect(":memory:")
    db.init_schema(conn)
    return conn


def src(provider: str, pid: str, *, name=None, type="Run", start="06:00", day="2026-08-01",
        start_time=None, elapsed=3600, moving=None, distance=None, utc_offset_s=None,
        reported=None, hr_zones=None, gear=None, summary=None, file_sha256=None,
        parsed=None, fetched_at=FETCHED) -> SourceActivity:
    rep = {k: None for k in REPORTED_KEYS}
    rep.update(reported or {})
    return SourceActivity(
        provider=provider, provider_activity_id=pid,
        name=name if name is not None else f"{provider} {pid}", type=type,
        start_time=start_time or at(start, day),
        elapsed_s=elapsed, moving_s=moving, distance_m=distance, utc_offset_s=utc_offset_s,
        reported=rep, hr_zones=hr_zones, gear=list(gear or []), summary=dict(summary or {}),
        file_sha256=file_sha256, parsed=parsed, fetched_at=fetched_at,
    )


def garmin_heart_rate(day: str, offset_s: int, values: list) -> bytes:
    """A dailyHeartRate response for ``day`` in the real shape: the local day
    at a fixed UTC offset, ``values`` as [unix_s, bpm | None] pairs."""
    start = datetime.combine(date.fromisoformat(day), datetime.min.time())
    fmt = lambda t: t.isoformat(timespec="milliseconds")[:-2]       # "2026-10-30T00:00:00.0"
    return json.dumps({
        "calendarDate": day,
        "startTimestampGMT": fmt(start - timedelta(seconds=offset_s)),
        "endTimestampGMT": fmt(start + timedelta(days=1, seconds=-offset_s)),
        "startTimestampLocal": fmt(start), "endTimestampLocal": fmt(start + timedelta(days=1)),
        "heartRateValueDescriptors": [{"key": "timestamp", "index": 0}, {"key": "heartrate", "index": 1}],
        "heartRateValues": [[t * 1000, v] for t, v in values],
    }).encode()
