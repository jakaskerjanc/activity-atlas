import pytest

from ingest.mcp_server.daily import wellness
from ingest.mcp_server.database import Database
from ingest.mcp_server.samples import activity_samples, bucket_average, wellness_series
from ingest.tests.mcp_fixture import build_fixture_db


@pytest.fixture
def db(tmp_path):
    d = Database(build_fixture_db(str(tmp_path / "f.sqlite")))
    yield d
    d.close()


def test_bucket_average_skips_none():
    t, c = bucket_average([0, 1, 2, 3], {"hr": [100, None, 110, 120]}, 2)
    assert t == [0, 2] and c["hr"] == [100, 115]


def test_bucket_average_empty_bucket_is_none():
    t, c = bucket_average([0, 1], {"hr": [None, None]}, 2)
    assert c["hr"] == [None]


def test_samples_default_channels(db):
    r = activity_samples(db, "run1")
    assert r["data"]["columns"] == ["t_s", "lat", "lon", "altitude", "hr", "distance"]
    assert r["data"]["units"]["hr"] == "bpm"


def test_samples_capped(db):
    r = activity_samples(db, "run1", ["hr"], max_points=5)
    assert len(r["data"]["rows"]) <= 5
    assert r["data"]["every_s"] == 541  # ceil((2700 - 0 + 1) / 5)


def test_samples_every_s(db):
    r = activity_samples(db, "run1", ["hr"], every_s=600)
    assert r["data"]["rows"][0] == [0, 141.0]


def test_samples_none_for_no_stream(db):
    r = activity_samples(db, "run2")
    assert r["data"]["rows"] == [] and r["counted"]["excluded"]["no samples stored"] == 1


def test_samples_unknown_channel(db):
    with pytest.raises(ValueError):
        activity_samples(db, "run1", ["heartrate"])


def test_samples_unknown_activity(db):
    with pytest.raises(ValueError):
        activity_samples(db, "nope")


def test_series_downsampled(db):
    r = wellness_series(db, "2025-03-10", "hr", max_points=24)
    assert len(r["data"]["rows"]) == 24 and r["data"]["rows"][0][0] == "00:00"
    assert r["data"]["columns"] == ["local_time", "hr"]


def test_series_missing_day_reports_coverage(db):
    r = wellness_series(db, "2030-01-01", "hr")
    assert r["data"]["rows"] == [] and r["data"]["coverage"] == {"first": "2025-03-10", "last": "2025-03-10"}


def test_every_s_cannot_exceed_the_point_cap(db):  # review Important 3
    r = activity_samples(db, "run1", ["hr"], every_s=1, max_points=5)
    assert len(r["data"]["rows"]) <= 5 and r["data"]["every_s"] == 541
    r = wellness_series(db, "2025-03-10", "hr", every_s=1e-7, max_points=24)
    assert len(r["data"]["rows"]) <= 24


def test_every_s_must_be_positive(db):
    with pytest.raises(ValueError):
        activity_samples(db, "run1", ["hr"], every_s=-5)


def test_wellness_days_capped(db):  # review Important 4
    r = wellness(db, "2025-03-10", "2025-03-16", max_rows=3)
    assert len(r["data"]["rows"]) == 3 and r["data"]["truncated"] is True
    assert wellness(db, "2025-03-10", "2025-03-16")["data"]["truncated"] is False


def test_wellness_per_day(db):
    rows = wellness(db, "2025-03-10", "2025-03-11", ["resting_hr"])["data"]["rows"]
    assert rows == [{"date": "2025-03-10", "resting_hr": 50}, {"date": "2025-03-11", "resting_hr": 51}]


def test_wellness_period_counts_days(db):
    r = wellness(db, "2025-03-10", "2025-03-16", ["hrv_avg"], period="week")
    row = r["data"]["rows"][0]
    assert row["period"] == "2025-03-10"
    assert row["hrv_avg"]["days_with_value"] == 6
    assert row["hrv_avg"]["min"] == 40 and row["hrv_avg"]["max"] == 46


def test_wellness_never_returns_raw(db):
    assert "secret" not in str(wellness(db, "2025-03-10", "2025-03-16"))


def test_wellness_unknown_metric(db):
    with pytest.raises(ValueError, match="resting_hr"):
        wellness(db, "2025-03-10", "2025-03-16", ["nope"])
