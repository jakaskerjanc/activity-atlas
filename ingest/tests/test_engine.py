import pytest

from ingest import db, engine
from ingest.archive import LocalArchive
from ingest.records import SourceRecord
from ingest.tests.factories import NOW, fixture_bytes, fresh, src
from ingest import matcher


def test_to_source_warns_on_unreadable_file(tmp_path):
    arch = LocalArchive(str(tmp_path))
    sha = arch.put_blob(b"garbage")
    rec = SourceRecord("strava", "1", NOW, {"Activity ID": "1", "Activity Date": "Aug 1, 2026, 6:30:00 AM",
                                             "Activity Name": "Run", "Activity Type": "Run"},
                       sha, "1.fit", {"kind": "strava_export"})
    with pytest.warns(UserWarning, match="unreadable activity file 1.fit"):
        s = engine.to_source(rec, arch)
    assert s.parsed is None and s.file_sha256 == sha


def test_apply_records_counts_and_raw_files(tmp_path):
    arch = LocalArchive(str(tmp_path))
    sha = arch.put_blob(fixture_bytes("sample.gpx"))
    rec = SourceRecord("strava", "1", NOW, {"Activity ID": "1", "Activity Date": "Aug 1, 2026, 6:30:00 AM",
                                             "Activity Name": "Run", "Activity Type": "Run"},
                       sha, "1.gpx", {"kind": "strava_export"})
    conn = fresh()
    assert engine.apply_records(conn, arch, [rec], now=NOW) == {"insert": 1, "update": 0, "merge": 0}
    row = conn.execute("SELECT * FROM raw_files WHERE sha256=?", (sha,)).fetchone()
    assert (row["kind"], row["provider"], row["provider_ref"], row["original_name"]) == ("activity_file", "strava", "1", "1.gpx")
    assert engine.apply_records(conn, arch, [rec], now=NOW) == {"insert": 0, "update": 1, "merge": 0}


def test_mark_missing_deleted_only_in_range():
    conn = fresh()
    for pid, day in (("1", "2026-08-01"), ("2", "2026-08-02"), ("3", "2026-08-05")):
        matcher.reconcile(conn, src("strava", pid, day=day), now=NOW)
    n = engine.mark_missing_deleted(conn, "strava", {"1"}, "2026-08-01T00:00:00+00:00",
                                    "2026-08-03T00:00:00+00:00", now=NOW)
    assert n == 1
    deleted = [r[0] for r in conn.execute("SELECT provider_activity_id FROM activity_sources WHERE deleted_at IS NOT NULL")]
    assert deleted == ["2"]
