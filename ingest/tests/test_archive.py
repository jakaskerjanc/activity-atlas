import pytest
from ingest.archive import LocalArchive, open_archive
from ingest.records import SourceRecord, latest


def _rec(fetched_at="2026-10-27T10:00:00+00:00", name="Run"):
    return SourceRecord("garmin", "900", fetched_at, {"activityName": name}, None, None, {"kind": "garmin_api"})


def test_blobs_are_content_addressed_and_idempotent(tmp_path):
    a = LocalArchive(str(tmp_path))
    sha = a.put_blob(b"fit-bytes")
    assert a.put_blob(b"fit-bytes") == sha and a.get_blob(sha) == b"fit-bytes"
    assert a.has_blob(sha) and not a.has_blob("0" * 64)
    assert len(list((tmp_path / "raw").iterdir())) == 1
    with pytest.raises(KeyError):
        a.get_blob("0" * 64)


def test_put_export_is_byte_identical(tmp_path):
    src = tmp_path / "export_123.zip"; src.write_bytes(b"PK\x03\x04zip")
    a = LocalArchive(str(tmp_path / "arch"))
    key = a.put_export("strava", str(src), today="2026-10-27")
    assert key == "exports/strava/2026-10-27-export_123.zip"
    assert (tmp_path / "arch" / key).read_bytes() == b"PK\x03\x04zip"


def test_put_record_skips_unchanged_but_keeps_a_b_a_edits(tmp_path):
    a = LocalArchive(str(tmp_path))
    assert a.put_record(_rec()) is True
    assert a.put_record(_rec("2026-10-28T10:00:00+00:00")) is False        # same content
    assert a.put_record(_rec("2026-10-29T10:00:00+00:00", "Renamed")) is True
    assert a.put_record(_rec("2026-10-30T10:00:00+00:00", "Run")) is True  # back to A is a change
    assert [r.summary["activityName"] for r in latest(a.list_records())] == ["Run"]


def test_record_json_round_trip():
    r = _rec()
    assert SourceRecord.from_json(r.to_json()) == r


def test_open_archive_defaults_and_rejects_unknown(monkeypatch, tmp_path):
    monkeypatch.setenv("ARCHIVE_URL", f"file://{tmp_path}")
    assert isinstance(open_archive(), LocalArchive)
    with pytest.raises(ValueError):
        open_archive("s3://x")


def test_put_export_reuses_key_for_identical_bytes(tmp_path):
    src = tmp_path / "export_123.zip"; src.write_bytes(b"PK\x03\x04zip")
    a = LocalArchive(str(tmp_path / "arch"))
    first = a.put_export("strava", str(src), today="2026-10-27")
    assert a.put_export("strava", str(src), today="2026-10-28") == first
    src.write_bytes(b"PK\x03\x04zip2")
    assert a.put_export("strava", str(src), today="2026-10-28") == "exports/strava/2026-10-28-export_123.zip"
