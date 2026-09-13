from datetime import datetime, timezone
from ingest.model import RawActivity, Activity


def test_raw_activity_defaults():
    r = RawActivity(source="garmin", source_id="9", name="n", type_raw="running",
                    start_time=datetime(2026, 8, 1, tzinfo=timezone.utc),
                    distance_m=1.0, moving_time_s=2, elevation_gain_m=3.0)
    assert r.track == [] and r.source_file is None


def test_activity_fields():
    a = Activity(id="s:1", strava_id="1", garmin_id=None, name="n", type="Run",
                 start_time="2026-08-01T00:00:00+00:00", distance=1.0, moving_time=2,
                 elevation_gain=3.0, polyline="", start_lat=None, start_lng=None)
    assert a.id == "s:1" and a.garmin_id is None
