from datetime import datetime, timezone

from ingest.model import REPORTED_KEYS, SourceActivity


def test_source_activity_fields():
    s = SourceActivity(provider="garmin", provider_activity_id="9", name="n", type="Run",
                       start_time=datetime(2026, 8, 1, tzinfo=timezone.utc), elapsed_s=None,
                       moving_s=None, distance_m=None, utc_offset_s=None,
                       reported={k: None for k in REPORTED_KEYS}, hr_zones=None, gear=[],
                       summary={}, file_sha256=None, parsed=None, fetched_at="2026-08-01T00:00:00+00:00")
    assert s.provider == "garmin" and s.parsed is None
