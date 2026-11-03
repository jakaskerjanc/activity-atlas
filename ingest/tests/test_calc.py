from datetime import datetime, timezone

import pytest

from ingest import calc
from ingest.tests.factories import outdoor as _outdoor


def test_time_in_zones_matches_garmin_convention():
    p = _outdoor()
    got = calc.time_in_zones(p.streams["time"], p.streams["hr"], [97, 116, 136, 155, 175, 194])
    assert got == [1741.0, 1305.0, 652.0, 0.0, 0.0, 0.0, 0.0]      # Garmin reports 1741.278 / 1304.387 / 652.002


def test_elevation_hysteresis_matches_reported_within_2m():
    gain, loss = calc.elevation_gain_loss(_outdoor().streams["altitude"])
    assert gain == pytest.approx(130.2, abs=0.05) and loss == pytest.approx(124.0, abs=0.05)


def test_time_weighted_mean_ignores_missing():
    assert calc.time_weighted_mean([0, 10, 20, 30], [100, None, 200, 999]) == pytest.approx(150.0)


def test_local_offset_from_coordinates():
    assert calc.local_offset_s(46.05, 14.5, datetime(2026, 2, 18, 16, tzinfo=timezone.utc)) == 3600
    assert calc.local_offset_s(46.05, 14.5, datetime(2025, 7, 10, 5, tzinfo=timezone.utc)) == 7200


def test_series_max_and_bbox_skip_missing():
    assert calc.series_max([None, 3, 7, None, 5]) == 7
    assert calc.series_max([None]) is None
    assert calc.bbox([None, 46.0, 46.2], [None, 14.5, 14.1]) == (46.0, 14.1, 46.2, 14.5)
    assert calc.bbox([None], [None]) is None


def test_cumulative_distance_haversine():
    d = calc.cumulative_distance([46.0, None, 46.001], [14.5, None, 14.5])
    assert d[0] == 0.0 and d[1] is None and d[2] == pytest.approx(111.2, abs=0.2)
