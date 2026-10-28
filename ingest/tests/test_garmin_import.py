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


def _garmin_zip(tmp_path, run_distance_cm=1025050, name="garmin_export.zip", made=(2026, 1, 1, 0, 0, 0),
                with_gym=True):
    summaries = [[
        {"activityId": 900001, "name": "Match Run", "activityType": "running",
         "startTimeGmt": _outdoor_start_ms(), "distance": run_distance_cm, "duration": 3700000,
         "movingDuration": 3600000, "elevationGain": 12000},
        {"activityId": 900002, "name": "Gym", "activityType": "strength_training",
         "startTimeGmt": 1785998400000, "distance": 0, "duration": 2400000,
         "movingDuration": None, "elevationGain": None},
    ]]
    if not with_gym:
        # a later activity widens the date range so the missing gym falls inside it
        summaries[0][1] = {"activityId": 900003, "name": "Late Walk", "activityType": "walking",
                           "startTimeGmt": 1786998400000, "distance": 100000, "duration": 1800000,
                           "movingDuration": 1800000, "elevationGain": None}
    path = tmp_path / name
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("DI_CONNECT/DI-Connect-Fitness/u_1_summarizedActivities.json", date_time=made),
                    json.dumps(summaries))
        zf.writestr(zipfile.ZipInfo("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip", date_time=made),
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


def test_older_garmin_export_marks_nothing_deleted(tmp_path):
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    older = _garmin_zip(tmp_path, name="older.zip", made=(2026, 9, 1, 0, 0, 0))
    newer = _garmin_zip(tmp_path, name="newer.zip", made=(2026, 10, 20, 0, 0, 0), with_gym=False)
    GarminImporter(older, dbp, arch, now="2026-10-21T10:00:00+00:00").run()
    GarminImporter(newer, dbp, arch, now="2026-10-22T10:00:00+00:00").run()
    gym = "SELECT deleted_at FROM activity_sources WHERE provider='garmin' AND provider_activity_id='900002'"
    deleted_at = db.connect(dbp).execute(gym).fetchone()[0]
    assert deleted_at is not None
    with pytest.warns(UserWarning, match="older than an export already imported"):
        GarminImporter(older, dbp, arch, now="2026-10-23T10:00:00+00:00").run()
    assert db.connect(dbp).execute(gym).fetchone()[0] == deleted_at
