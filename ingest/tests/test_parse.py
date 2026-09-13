import io
import os
from ingest.parse.gpx import parse_gpx
from ingest.parse.tcx import parse_tcx
from ingest.parse.fit import parse_fit

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def test_gpx():
    with open(os.path.join(FIX, "sample.gpx"), "rb") as f:
        p = parse_gpx(f)
    assert len(p.track) == 3
    assert p.track[0] == (46.05, 14.5)
    assert p.start_time is not None


def test_tcx_skips_points_without_position():
    with open(os.path.join(FIX, "sample.tcx"), "rb") as f:
        p = parse_tcx(f)
    assert len(p.track) == 2          # 3rd trackpoint has no Position
    assert p.track[1] == (46.051, 14.501)


def test_tcx_tolerates_leading_whitespace():
    with open(os.path.join(FIX, "sample.tcx"), "rb") as f:
        raw = f.read()
    p = parse_tcx(io.BytesIO(b"          " + raw))
    assert len(p.track) == 2
    assert p.track[1] == (46.051, 14.501)


def test_fit_outdoor_has_gps_and_type_activity():
    with open(os.path.join(FIX, "outdoor.fit"), "rb") as f:
        p = parse_fit(f)
    assert p.file_type == "activity"
    assert len(p.track) > 100
    assert p.start_time is not None
    lat, lon = p.track[0]
    assert -90 <= lat <= 90 and -180 <= lon <= 180   # semicircles converted


def test_fit_indoor_activity_has_no_gps():
    with open(os.path.join(FIX, "indoor.fit"), "rb") as f:
        p = parse_fit(f)
    assert p.file_type == "activity" and p.track == []


def test_fit_classify_only_is_cheap():
    with open(os.path.join(FIX, "monitoring.fit"), "rb") as f:
        p = parse_fit(f, geometry=False)
    assert p.file_type != "activity" and p.track == []
