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


import pytest
from ingest.parse import fit as fit_mod


def _fit(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return parse_fit(f)


def test_fit_outdoor_streams_summary_zones_offset():
    p = _fit("outdoor.fit")
    assert set(p.streams) == {"time", "lat", "lon", "altitude", "hr", "cadence", "speed", "distance", "temperature"}
    assert len(p.streams["time"]) == 3673 and p.streams["time"][0] == 0.0
    assert p.streams["hr"][0] == 112 and p.streams["altitude"][0] == 299.0 and p.streams["cadence"][0] == 53
    s = p.summary
    assert (s["avg_hr"], s["max_hr"], s["calories"]) == (97, 135, 330)
    assert (s["elevation_gain_m"], s["elevation_loss_m"]) == (130, 125)
    assert s["distance_m"] == 4662.85 and s["elapsed_s"] == pytest.approx(3697.667)
    assert p.hr_zones == {"seconds": [1741.278, 1304.387, 652.002, 0.0, 0.0, 0.0, 0.0],
                          "limits": [97, 116, 136, 155, 175, 194]}
    assert p.utc_offset_s == 3600 and len(p.laps) == 1 and len(p.track) == 3673


def test_fit_indoor_has_hr_but_no_position():
    p = _fit("indoor.fit")
    assert set(p.streams) == {"time", "hr", "distance"} and len(p.streams["hr"]) == 1594
    assert p.track == [] and p.utc_offset_s == 7200 and p.summary["avg_hr"] == 95


TCX_HR = b'''<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Lap StartTime="2026-08-01T06:30:00Z"><TotalTimeSeconds>10</TotalTimeSeconds><DistanceMeters>30</DistanceMeters><Calories>5</Calories><AverageHeartRateBpm><Value>120</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>130</Value></MaximumHeartRateBpm><Track>
<Trackpoint><Time>2026-08-01T06:30:00Z</Time><AltitudeMeters>300.5</AltitudeMeters><HeartRateBpm><Value>110</Value></HeartRateBpm></Trackpoint>
<Trackpoint><Time>2026-08-01T06:30:10Z</Time><Position><LatitudeDegrees>46.051</LatitudeDegrees><LongitudeDegrees>14.501</LongitudeDegrees></Position><DistanceMeters>30</DistanceMeters><HeartRateBpm><Value>130</Value></HeartRateBpm><Cadence>80</Cadence></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>'''


def test_tcx_streams_keep_positionless_points_and_lap_summary():
    p = parse_tcx(io.BytesIO(TCX_HR))
    assert p.streams["time"] == [0.0, 10.0] and p.streams["hr"] == [110, 130]
    assert p.streams["altitude"] == [300.5, None] and p.streams["lat"] == [None, 46.051]
    assert p.track == [(46.051, 14.501)]
    assert (p.summary["elapsed_s"], p.summary["distance_m"], p.summary["calories"]) == (10, 30, 5)
    assert (p.summary["avg_hr"], p.summary["max_hr"]) == (120, 130)
    assert p.sport == "Biking" and len(p.laps) == 1


GPX_HR = b'''<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><trkseg>
<trkpt lat="46.05" lon="14.5"><ele>300</ele><time>2026-08-01T06:30:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>101</gpxtpx:hr><gpxtpx:cad>77</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="46.051" lon="14.501"><ele>301</ele><time>2026-08-01T06:30:05Z</time></trkpt>
</trkseg></trk></gpx>'''


def test_gpx_reads_extension_hr_and_cadence():
    p = parse_gpx(io.BytesIO(GPX_HR))
    assert p.streams["time"] == [0.0, 5.0] and p.streams["altitude"] == [300.0, 301.0]
    assert p.streams["hr"] == [101, None] and p.streams["cadence"] == [77, None]


def test_dispatch_gunzips_and_matches_direct_parse():
    import gzip
    from ingest.parse.dispatch import parse_bytes
    raw = open(os.path.join(FIX, "outdoor.fit"), "rb").read()
    assert len(parse_bytes("a.fit.gz", gzip.compress(raw)).streams["hr"]) == 3673
    with pytest.raises(ValueError):
        parse_bytes("a.csv", b"x")


class _FakeMsg:
    def __init__(self, name, values):
        self.name = name
        self._values = values
        self.fields = [type("F", (), {"name": k, "value": v})() for k, v in values.items()]

    def get_value(self, key, fallback=None):
        return self._values.get(key, fallback)


def test_fit_record_without_timestamp_is_skipped(monkeypatch):
    from datetime import datetime, timezone
    t0 = datetime(2026, 8, 1, 6, 30, tzinfo=timezone.utc)
    frames = [
        _FakeMsg("file_id", {"type": "activity", "time_created": t0}),
        _FakeMsg("record", {"timestamp": t0, "heart_rate": 100}),
        _FakeMsg("record", {"heart_rate": 105}),                       # no timestamp -> skipped
        _FakeMsg("record", {"timestamp": t0.replace(second=5), "heart_rate": 110}),
        _FakeMsg("record", {"timestamp": t0.replace(second=2), "heart_rate": 120}),  # device reset: kept in file order
    ]

    class _Reader:
        def __init__(self, fileobj): pass
        def __enter__(self): return iter(frames)
        def __exit__(self, *a): return False

    monkeypatch.setattr(fit_mod.fitdecode, "FitReader", _Reader)
    monkeypatch.setattr(fit_mod.fitdecode, "FitDataMessage", _FakeMsg)
    p = parse_fit(io.BytesIO(b""))
    assert p.streams["hr"] == [100, 110, 120]
    assert p.streams["time"] == [0.0, 5.0, 2.0]


def test_parse_monitoring_fixture():
    from datetime import datetime
    from ingest.parse.monitoring import MONITORING_FILE_TYPES, parse_monitoring

    def unix(iso):
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())

    with open(os.path.join(FIX, "monitoring.fit"), "rb") as f:
        data = f.read()
    assert parse_fit(io.BytesIO(data), geometry=False).file_type in MONITORING_FILE_TYPES
    m = parse_monitoring(data)
    assert m.utc_offset_s == 7200
    hr, stress, resp = m.series["hr"], m.series["stress"], m.series["respiration"]
    assert len(hr) == 193
    assert hr[0] == (unix("2026-04-10T22:25:00Z"), 74)
    assert hr[-1] == (unix("2026-04-11T03:30:00Z"), 58)
    assert len(stress) == 304
    assert stress[0] == (unix("2026-04-10T22:25:00Z"), 31)
    assert len(resp) == 305
    assert resp[0] == (unix("2026-04-10T22:26:00Z"), 18.58)
    assert m.resting == {"2026-04-11": {"resting_heart_rate": 57,
                                        "current_day_resting_heart_rate": 59}}
