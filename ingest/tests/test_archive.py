import hashlib

import pytest
from ingest.archive import LocalArchive, open_archive
from ingest.records import SourceRecord, WellnessRecord, _canonical, latest


def _rec(fetched_at="2026-10-27T10:00:00+00:00", name="Run", as_of=None):
    return SourceRecord("garmin", "900", fetched_at, {"activityName": name}, None, None, {"kind": "garmin_api"}, as_of)


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


def test_latest_prefers_as_of_over_fetched_at():
    a = _rec("2026-10-27T10:00:00+00:00", "A", as_of="2026-10-01T00:00:00+00:00")
    b = _rec("2026-10-20T10:00:00+00:00", "B")
    assert latest([a, b]) == [b]


def test_record_without_as_of_keeps_plan1_hash():
    r = _rec()
    plan1 = {"provider": "garmin", "provider_activity_id": "900", "summary": {"activityName": "Run"},
             "file_sha256": None, "file_name": None, "origin": {"kind": "garmin_api"}}
    assert r.content_sha() == hashlib.sha256(_canonical(plan1)).hexdigest()
    assert b"as_of" not in r.to_json()
    loaded = SourceRecord.from_json(_canonical({**plan1, "fetched_at": "2026-10-27T10:00:00+00:00"}))
    assert loaded == r and loaded.as_of is None
    with_as_of = _rec(as_of="2026-10-01T00:00:00+00:00")
    assert SourceRecord.from_json(with_as_of.to_json()) == with_as_of
    assert with_as_of.content_sha() != r.content_sha()


def test_put_record_compares_with_newest_by_recency(tmp_path):
    a = LocalArchive(str(tmp_path))
    b = _rec("2026-10-20T10:00:00+00:00", "B")
    older = _rec("2026-10-28T10:00:00+00:00", "A", as_of="2026-10-01T00:00:00+00:00")
    assert a.put_record(b) is True
    assert a.put_record(older) is True
    assert latest(a.list_records()) == [b]


def _wrec(fetched_at="2026-10-27T10:00:00+00:00", blob="a" * 64):
    return WellnessRecord("garmin", "monitoring_fit", "a" * 64, fetched_at, blob, "1.fit",
                          {"kind": "garmin_export"})


def test_put_wellness_skips_identical_and_lists(tmp_path):
    a = LocalArchive(str(tmp_path))
    first = _wrec()
    assert a.put_wellness(first) is True
    assert a.put_wellness(_wrec("2026-10-28T10:00:00+00:00")) is False     # same content
    changed = _wrec("2026-10-29T10:00:00+00:00", blob="b" * 64)
    assert a.put_wellness(changed) is True
    assert sorted(a.list_wellness(), key=lambda r: r.fetched_at) == [first, changed]
    assert WellnessRecord.from_json(first.to_json()) == first
    stored = sorted(p.name for p in (tmp_path / "wellness" / "garmin" / "monitoring_fit" / ("a" * 64)).iterdir())
    assert stored == [f"20261027T100000Z-{first.content_sha()[:12]}.json",
                      f"20261029T100000Z-{changed.content_sha()[:12]}.json"]
