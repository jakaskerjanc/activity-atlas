import gzip
import os
import zipfile
from datetime import timezone

import pytest

from ingest import db
from ingest.archive import LocalArchive
from ingest.export_reader import export_made_at
from ingest.strava_import import StravaImporter, _parse_date
from ingest.tests.factories import fixture_bytes

HEADER = ("Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time,"
          "Elevation Gain,Elevation Loss,Average Heart Rate,Max Heart Rate,Average Cadence,Max Cadence,"
          "Average Watts,Max Watts,Calories,Activity Gear,Filename\n")


def _row(aid, date, name, typ, file="", elapsed="3700", distance="4662.8", hr=""):
    return f'{aid},"{date}",{name},{typ},{elapsed},{distance},3600,120.0,,{hr},,,,,,,,{file}\n'


RUN = _row(111, "Feb 18, 2026, 4:06:36 PM", "Morning Walk", "Walk", "activities/111.fit.gz", hr="150")
GYM = _row(222, "Aug 2, 2026, 5:00:00 PM", "Strength", "Weight Training", elapsed="2400", distance="0")


def _zip(tmp_path, csv_text, members=None, name="export_1.zip", made=(2026, 1, 1, 0, 0, 0)):
    path = tmp_path / name
    members = {"activities/111.fit.gz": gzip.compress(fixture_bytes("outdoor.fit"))} if members is None else members
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("activities.csv", date_time=made), csv_text)
        for k, v in members.items():
            zf.writestr(zipfile.ZipInfo(k, date_time=made), v)
    return str(path)


def _activity_for(conn, provider, pid):
    return conn.execute(
        "SELECT a.* FROM activities a JOIN activity_sources s ON s.activity_id = a.id "
        "WHERE s.provider=? AND s.provider_activity_id=?", (provider, pid)).fetchone()


def _setup(tmp_path):
    return str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))


def _record_files(tmp_path):
    return sorted(p for p in (tmp_path / "arch" / "records").rglob("*.json"))


def test_zip_import_archives_export_and_maps_csv(tmp_path):
    dbp, arch = _setup(tmp_path)
    zip_path = _zip(tmp_path, HEADER + RUN + GYM)
    counts = StravaImporter(zip_path, dbp, arch, now="2026-10-27T10:00:00+00:00").run()
    assert counts == {"insert": 2, "update": 0, "merge": 0}
    stored = list((tmp_path / "arch" / "exports" / "strava").iterdir())
    assert [p.name for p in stored] == ["2026-10-27-export_1.zip"]
    assert stored[0].read_bytes() == open(zip_path, "rb").read()
    conn = db.connect(dbp)
    run = _activity_for(conn, "strava", "111")
    assert run["avg_hr"] == 150 and run["has_hr"] == 1 and run["polyline"] != ""   # CSV beats file's 97
    assert run["utc_offset_s"] == 3600 and run["calories"] == 330                   # from the FIT
    gym = _activity_for(conn, "strava", "222")
    assert gym["type"] == "WeightTraining" and gym["polyline"] == "" and gym["has_hr"] == 0
    kinds = {r[0] for r in conn.execute("SELECT kind FROM raw_files")}
    assert {"activity_file", "export_member"} <= kinds


def test_missing_mapped_headers_warn_once(tmp_path):
    dbp, arch = _setup(tmp_path)
    csv_text = ("Activity ID,Activity Date,Activity Name,Activity Type,Filename\n"
                '222,"Aug 2, 2026, 5:00:00 PM",Strength,Weight Training,\n')
    with pytest.warns(UserWarning) as rec:
        StravaImporter(_zip(tmp_path, csv_text, {}), dbp, arch).run()
    header_warnings = [w for w in rec if "absent" in str(w.message)]
    assert len(header_warnings) == 1
    msg = str(header_warnings[0].message)
    assert "Average Heart Rate" in msg and "Elevation Loss" in msg and "Activity Name" not in msg


def test_corrupt_file_keeps_activity_without_streams(tmp_path):
    dbp, arch = _setup(tmp_path)
    row = _row(111, "Aug 1, 2026, 6:30:00 AM", "Run", "Run", "activities/111.fit")
    with pytest.warns(UserWarning, match="unreadable activity file"):
        counts = StravaImporter(_zip(tmp_path, HEADER + row + GYM, {"activities/111.fit": b"garbage"}), dbp, arch).run()
    assert counts["insert"] == 2
    run = _activity_for(db.connect(dbp), "strava", "111")
    assert run is not None and run["streams_sha256"] is None and run["name"] == "Run"


def test_reimport_is_idempotent(tmp_path):
    dbp, arch = _setup(tmp_path)
    zip_path = _zip(tmp_path, HEADER + RUN + GYM)
    StravaImporter(zip_path, dbp, arch, now="2026-10-27T10:00:00+00:00").run()
    files = _record_files(tmp_path)
    conn = db.connect(dbp)
    before = [tuple(r) for r in conn.execute("SELECT * FROM activities ORDER BY id")]
    conn.close()
    counts = StravaImporter(zip_path, dbp, arch, now="2026-10-28T10:00:00+00:00").run()
    assert counts == {"insert": 0, "update": 2, "merge": 0}
    assert _record_files(tmp_path) == files
    conn = db.connect(dbp)
    assert [tuple(r) for r in conn.execute("SELECT * FROM activities ORDER BY id")] == before


def test_newer_export_missing_activity_marks_it_deleted(tmp_path):
    dbp, arch = _setup(tmp_path)
    r1 = _row(111, "Aug 1, 2026, 6:30:00 AM", "A", "Run")
    r2 = _row(222, "Aug 2, 2026, 6:30:00 AM", "B", "Run")
    r3 = _row(333, "Aug 3, 2026, 6:30:00 AM", "C", "Run")
    StravaImporter(_zip(tmp_path, HEADER + r1 + r2, {}, "e1.zip"), dbp, arch, now="2026-10-01T10:00:00+00:00").run()
    StravaImporter(_zip(tmp_path, HEADER + r1 + r3, {}, "e2.zip"), dbp, arch, now="2026-10-20T10:00:00+00:00").run()
    conn = db.connect(dbp)
    src = conn.execute("SELECT deleted_at FROM activity_sources WHERE provider_activity_id='222'").fetchone()
    assert src["deleted_at"] == "2026-10-20T10:00:00+00:00"
    assert _activity_for(conn, "strava", "222")["visible"] == 0
    assert _activity_for(conn, "strava", "111")["visible"] == 1


def test_directory_input_warns_no_export_stored(tmp_path):
    dbp, arch = _setup(tmp_path)
    root = tmp_path / "strava"
    (root / "activities").mkdir(parents=True)
    (root / "activities" / "111.gpx").write_bytes(fixture_bytes("sample.gpx"))
    (root / "activities.csv").write_text(HEADER + _row(111, "Aug 1, 2026, 6:30:00 AM", "Run", "Run", "activities/111.gpx"))
    with pytest.warns(UserWarning, match="directory input: no export archive stored"):
        counts = StravaImporter(str(root), dbp, arch).run()
    assert counts["insert"] == 1
    assert not (tmp_path / "arch" / "exports").exists()
    assert _activity_for(db.connect(dbp), "strava", "111")["polyline"] != ""


def test_parse_date_am_pm_is_utc():
    assert _parse_date("Aug 1, 2026, 6:30:00 AM").tzinfo == timezone.utc


def test_duplicate_distance_columns_last_wins(tmp_path):
    # Real Strava exports repeat Distance; DictReader keeps the last = meters.
    dbp, arch = _setup(tmp_path)
    csv_text = (
        "Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time,Elevation Gain,Distance,Filename\n"
        '111,"Aug 1, 2026, 6:30:00 AM",Run,Run,10.25,3600,120.0,10250.5,\n'
    )
    with pytest.warns(UserWarning):
        StravaImporter(_zip(tmp_path, csv_text, {}), dbp, arch).run()
    assert _activity_for(db.connect(dbp), "strava", "111")["distance"] == 10250.5


def test_reupload_with_new_id_joins_the_same_activity(tmp_path):
    dbp, arch = _setup(tmp_path)
    old = _row(111, "Aug 1, 2026, 6:30:00 AM", "Walk", "Walk", elapsed="3600")
    new = _row(112, "Aug 1, 2026, 6:30:00 AM", "Walk", "Walk", elapsed="3600")
    other = _row(333, "Aug 3, 2026, 6:30:00 AM", "C", "Run")
    StravaImporter(_zip(tmp_path, HEADER + old + other, {}, "e1.zip"), dbp, arch, now="2026-10-01T10:00:00+00:00").run()
    conn = db.connect(dbp)
    first = _activity_for(conn, "strava", "111")["id"]
    conn.execute("INSERT INTO activity_overrides (activity_id, hidden) VALUES (?, 1)", (first,))
    conn.commit(); conn.close()
    counts = StravaImporter(_zip(tmp_path, HEADER + new + other, {}, "e2.zip"), dbp, arch,
                            now="2026-10-20T10:00:00+00:00").run()
    assert counts["insert"] == 0
    conn = db.connect(dbp)
    act = _activity_for(conn, "strava", "112")
    assert act["id"] == first
    assert act["visible"] == 0
    assert conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == 2


def test_export_made_at_reads_newest_member_time(tmp_path):
    path = tmp_path / "e.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(zipfile.ZipInfo("a.txt", date_time=(2026, 10, 19, 7, 0, 0)), "a")
        zf.writestr(zipfile.ZipInfo("b.txt", date_time=(2026, 10, 20, 8, 0, 0)), "b")
    assert export_made_at(str(path)) == "2026-10-20T08:00:00+00:00"
    folder = tmp_path / "folder"
    folder.mkdir()
    assert export_made_at(str(folder)) is None


def test_export_made_at_ignores_zips_without_dates(tmp_path):
    assert export_made_at(_zip(tmp_path, HEADER, {}, made=(1980, 1, 1, 0, 0, 0))) is None


def test_export_made_at_ignores_invalid_dos_dates(tmp_path):
    path = _zip(tmp_path, HEADER, {"b.txt": b"b"}, made=(1980, 0, 0, 0, 0, 0))
    assert export_made_at(path) is None
    with zipfile.ZipFile(path, "a") as zf:
        zf.writestr(zipfile.ZipInfo("c.txt", date_time=(2026, 10, 20, 8, 0, 0)), "c")
    assert export_made_at(path) == "2026-10-20T08:00:00+00:00"
    StravaImporter(path, str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch")),
                   now="2026-10-27T10:00:00+00:00").run()


def test_older_export_does_not_roll_back_or_undelete(tmp_path):
    dbp, arch = _setup(tmp_path)
    r111 = lambda name: _row(111, "Feb 18, 2026, 4:06:36 PM", name, "Walk", "activities/111.fit.gz", hr="150")
    r222 = _row(222, "Aug 2, 2026, 5:00:00 PM", "Strength", "Weight Training", elapsed="2400", distance="0")
    r333 = _row(333, "Aug 3, 2026, 5:00:00 PM", "Other", "Weight Training", elapsed="2400", distance="0")
    e_old = _zip(tmp_path, HEADER + r111("Old") + r222 + r333, name="old.zip", made=(2026, 9, 1, 0, 0, 0))
    e_new = _zip(tmp_path, HEADER + r111("Edited") + r333, name="new.zip", made=(2026, 10, 20, 0, 0, 0))
    StravaImporter(e_old, dbp, arch, now="2026-10-21T10:00:00+00:00").run()
    StravaImporter(e_new, dbp, arch, now="2026-10-22T10:00:00+00:00").run()
    conn = db.connect(dbp)
    deleted_at = conn.execute("SELECT deleted_at FROM activity_sources WHERE provider_activity_id='222'").fetchone()[0]
    assert deleted_at is not None
    with pytest.warns(UserWarning, match="older than an export already imported"):
        StravaImporter(e_old, dbp, arch, now="2026-10-23T10:00:00+00:00").run()
    conn = db.connect(dbp)
    assert _activity_for(conn, "strava", "111")["name"] == "Edited"
    assert conn.execute("SELECT deleted_at FROM activity_sources WHERE provider_activity_id='222'").fetchone()[0] == deleted_at
