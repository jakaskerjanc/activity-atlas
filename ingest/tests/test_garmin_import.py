import io
import json
import zipfile

import pytest

from ingest import db
from ingest.archive import LocalArchive
from ingest.garmin_import import GarminImporter, _iter_summaries
from ingest.strava_import import StravaImporter
from ingest.tests.factories import fixture_bytes, outdoor
from ingest.tests.test_strava_import import HEADER, _activity_for, _row, _zip

NOW = "2026-10-27T10:00:00+00:00"


def _outdoor_start_ms():
    return int(outdoor().start_time.timestamp() * 1000)


def _garmin_zip(tmp_path, run_distance_cm=1025050, name="garmin_export.zip"):
    summaries = [[
        {"activityId": 900001, "name": "Match Run", "activityType": "running",
         "startTimeGmt": _outdoor_start_ms(), "distance": run_distance_cm, "duration": 3700000,
         "movingDuration": 3600000, "elevationGain": 12000},
        {"activityId": 900002, "name": "Gym", "activityType": "strength_training",
         "startTimeGmt": 1785998400000, "distance": 0, "duration": 2400000,
         "movingDuration": None, "elevationGain": None},
    ]]
    path = tmp_path / name
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("DI_CONNECT/DI-Connect-Fitness/u_1_summarizedActivities.json", json.dumps(summaries))
        zf.writestr("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
                    fixture_bytes("garmin_uploaded.zip"))
    return str(path)


def test_iter_summaries_flattens_nested():
    got = [s["activityId"] for s in _iter_summaries([[{"activityId": 1}], {"activityId": 2}])]
    assert got == [1, 2]


def test_matches_fit_and_scales_units(tmp_path):
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    counts = GarminImporter(_garmin_zip(tmp_path), dbp, arch, now=NOW).run()
    assert counts == {"insert": 2, "update": 0, "merge": 0}
    assert [p.name for p in (tmp_path / "arch" / "exports" / "garmin").iterdir()] == ["2026-10-27-garmin_export.zip"]
    conn = db.connect(dbp)
    run = _activity_for(conn, "garmin", "900001")
    assert run["type"] == "Run" and run["distance"] == 10250.5 and run["elevation_gain"] == 120.0
    assert run["moving_time"] == 3600 and run["avg_hr"] == 97 and run["utc_offset_s"] == 3600
    assert json.loads(run["hr_zone_seconds"])[:3] == [1741.278, 1304.387, 652.002]
    assert run["polyline"] != ""
    gym = _activity_for(conn, "garmin", "900002")
    assert gym["polyline"] == "" and gym["moving_time"] == 2400 and gym["distance"] == 0.0
    assert gym["streams_sha256"] is None
    kinds = {r[0] for r in conn.execute("SELECT kind FROM raw_files")}
    assert {"activity_file", "export_member"} <= kinds


def test_strava_then_garmin_merge_with_strava_name(tmp_path):
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    walk = _row(111, "Feb 18, 2026, 4:06:36 PM", "Morning Walk", "Walk", "activities/outdoor.fit.gz")
    import gzip
    StravaImporter(_zip(tmp_path, HEADER + walk, {"activities/outdoor.fit.gz": gzip.compress(fixture_bytes("outdoor.fit"))}),
                   dbp, arch, now=NOW).run()
    with pytest.warns(UserWarning, match="types differ"):
        counts = GarminImporter(_garmin_zip(tmp_path, run_distance_cm=466285), dbp, arch, now=NOW).run()
    assert counts == {"insert": 1, "update": 0, "merge": 1}
    conn = db.connect(dbp)
    a = _activity_for(conn, "garmin", "900001")
    assert a["id"] == _activity_for(conn, "strava", "111")["id"] and a["name"] == "Morning Walk"
    shas = {r[0] for r in conn.execute("SELECT file_sha256 FROM activity_sources WHERE activity_id=?", (a["id"],))}
    assert len(shas) == 1 and a["streams_sha256"] in shas
    assert conn.execute("SELECT COUNT(*) FROM streams").fetchone()[0] == 1


def test_directory_input(tmp_path):
    root = tmp_path / "garmin"
    with zipfile.ZipFile(_garmin_zip(tmp_path)) as zf:
        zf.extractall(root)
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    with pytest.warns(UserWarning, match="directory input"):
        assert GarminImporter(str(root), dbp, arch, now=NOW).run()["insert"] == 2
