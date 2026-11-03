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
                with_gym=True, monitoring=False, monitoring_names=("monitoring.fit",)):
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
    # the fixture zip also holds a monitoring FIT; only `monitoring=True` should add one
    part1 = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(fixture_bytes("garmin_uploaded.zip"))) as src, zipfile.ZipFile(part1, "w") as dst:
        for member in src.namelist():
            if member != "u_3.fit":
                dst.writestr(member, src.read(member))
    path = tmp_path / name
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("DI_CONNECT/DI-Connect-Fitness/u_1_summarizedActivities.json", date_time=made),
                    json.dumps(summaries))
        zf.writestr(zipfile.ZipInfo("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip", date_time=made),
                    part1.getvalue())
        if monitoring:
            inner = io.BytesIO()
            with zipfile.ZipFile(inner, "w") as mz:
                for fit_name in monitoring_names:
                    mz.writestr(fit_name, fixture_bytes("monitoring.fit"))
            zf.writestr(zipfile.ZipInfo("DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip",
                                        date_time=made), inner.getvalue())
    return str(path)


def test_iter_summaries_flattens_nested():
    got = [s["activityId"] for s in _iter_summaries([[{"activityId": 1}], {"activityId": 2}])]
    assert got == [1, 2]


def test_matches_fit_and_scales_units(tmp_path):
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    counts = GarminImporter(_garmin_zip(tmp_path), dbp, arch, now=NOW).run()
    assert counts == {"insert": 2, "update": 0, "merge": 0, "wellness_days": 0}
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
    assert counts == {"insert": 1, "update": 0, "merge": 1, "wellness_days": 0}
    conn = db.connect(dbp)
    a = _activity_for(conn, "garmin", "900001")
    assert a["id"] == _activity_for(conn, "strava", "111")["id"] and a["name"] == "Morning Walk"
    shas = {r[0] for r in conn.execute("SELECT file_sha256 FROM activity_sources WHERE activity_id=?", (a["id"],))}
    assert len(shas) == 1 and a["streams_sha256"] in shas
    assert conn.execute("SELECT COUNT(*) FROM streams").fetchone()[0] == 1


def _wellness_files(arch_dir):
    return sorted((arch_dir / "wellness").rglob("*.json"))


def test_import_stores_monitoring_fits_as_wellness(tmp_path):
    dbp, arch_dir = str(tmp_path / "db.sqlite"), tmp_path / "arch"
    arch = LocalArchive(str(arch_dir))
    zpath = _garmin_zip(tmp_path, monitoring=True)
    assert GarminImporter(zpath, dbp, arch, now=NOW).run()["wellness_days"] == 1
    conn = db.connect(dbp)
    hr = conn.execute("SELECT sample_count FROM daily_series WHERE date='2026-04-11' AND channel='hr'").fetchone()
    assert hr[0] == 193
    files = _wellness_files(arch_dir)
    assert len(files) == 1
    assert conn.execute("SELECT COUNT(*) FROM raw_files WHERE kind='monitoring_fit'").fetchone()[0] == 1
    tables = ("daily_stats", "daily_series", "wellness_inputs")
    before = [conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in tables]
    conn.close()

    GarminImporter(zpath, dbp, arch, now="2026-10-28T10:00:00+00:00").run()
    assert _wellness_files(arch_dir) == files
    conn = db.connect(dbp)
    assert [conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in tables] == before


def test_identical_monitoring_bytes_under_several_names_write_one_record(tmp_path):
    dbp, arch_dir = str(tmp_path / "db.sqlite"), tmp_path / "arch"
    arch = LocalArchive(str(arch_dir))
    tables = ("daily_stats", "daily_series", "wellness_inputs")

    def snapshot():
        conn = db.connect(dbp)
        try:
            return [conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in tables]
        finally:
            conn.close()

    two_names = _garmin_zip(tmp_path, monitoring=True, monitoring_names=("u_3.fit", "monitoring.fit"))
    GarminImporter(two_names, dbp, arch, now="2026-10-26T10:00:00+00:00").run()
    files, before = _wellness_files(arch_dir), snapshot()
    assert len(files) == 1 and before[1]
    for day in ("27", "28"):
        GarminImporter(two_names, dbp, arch, now=f"2026-10-{day}T10:00:00+00:00").run()
    assert _wellness_files(arch_dir) == files and snapshot() == before

    third = _garmin_zip(tmp_path, name="third.zip", made=(2026, 10, 20, 0, 0, 0), monitoring=True,
                        monitoring_names=("extra.fit",))
    GarminImporter(third, dbp, arch, now="2026-10-29T10:00:00+00:00").run()
    assert _wellness_files(arch_dir) == files and snapshot() == before


def test_archive_failure_while_storing_monitoring_fit_propagates(tmp_path, monkeypatch):
    arch = LocalArchive(str(tmp_path / "arch"))

    def boom(rec):
        raise OSError("disk full")
    monkeypatch.setattr(arch, "put_wellness", boom)
    with pytest.raises(OSError, match="disk full"):
        GarminImporter(_garmin_zip(tmp_path, monitoring=True), str(tmp_path / "db.sqlite"), arch, now=NOW).run()


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
