import hashlib
import json

import pytest

from ingest import codec, wellness
from ingest.archive import LocalArchive
from ingest.records import WellnessRecord
from ingest.tests.factories import FETCHED, fixture_bytes, fresh
from ingest.wellness import DayPart, apply_wellness

DAY = "2026-04-11"


def _put(arch, data: bytes, *, source="monitoring_fit", key=None, kind="garmin_export"):
    sha = arch.put_blob(data)
    return WellnessRecord("garmin", source, key or sha, FETCHED, sha, "m.fit", {"kind": kind})


@pytest.fixture
def arch(tmp_path):
    return LocalArchive(str(tmp_path / "arch"))


@pytest.fixture
def mon(arch):
    return _put(arch, fixture_bytes("monitoring.fit"))


def _series(conn):
    return {r["channel"]: r for r in conn.execute("SELECT * FROM daily_series WHERE date=?", (DAY,))}


def _snapshot(conn):
    return [[tuple(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2")]
            for t in ("daily_stats", "daily_series", "wellness_inputs")]


def test_monitoring_fit_fills_series_and_resting_hr(arch, mon):
    conn = fresh()
    assert apply_wellness(conn, arch, [mon]) == 1
    rows = _series(conn)
    assert {ch: r["sample_count"] for ch, r in rows.items()} == {"hr": 193, "stress": 304, "respiration": 305}
    hr = rows["hr"]
    assert codec.decode("time", hr["time"])[0] == 1500.0                 # 00:25 local
    assert codec.decode("hr", hr["data"])[0] == 74
    assert hr["utc_offset_s"] == 7200 and hr["encoding"] == codec.ENCODING_VERSION
    stats = dict(conn.execute("SELECT * FROM daily_stats WHERE date=?", (DAY,)).fetchone())
    assert stats.pop("date") == DAY and stats.pop("resting_hr") == 59
    assert json.loads(stats.pop("raw"))["monitoring_fit"] == {"resting_heart_rate": 57,
                                                             "current_day_resting_heart_rate": 59}
    assert all(v is None for v in stats.values())
    assert [tuple(r) for r in conn.execute("SELECT * FROM wellness_inputs")] == [
        ("garmin", "monitoring_fit", mon.key, DAY, mon.blob_sha256, "m.fit")]
    assert tuple(conn.execute("SELECT kind, provider, provider_ref, original_name FROM raw_files").fetchone()) == (
        "monitoring_fit", "garmin", mon.key, "m.fit")


def test_duplicate_inputs_on_one_date_merge_without_duplicates(arch, mon):
    conn = fresh()
    twin = _put(arch, fixture_bytes("monitoring.fit"), key="f" * 64)
    apply_wellness(conn, arch, [mon, twin])
    assert conn.execute("SELECT COUNT(*) FROM wellness_inputs").fetchone()[0] == 2
    hr = _series(conn)["hr"]
    assert hr["sample_count"] == 193
    times = codec.decode("time", hr["time"])
    assert times == sorted(set(times))


def test_several_fits_on_one_date_agree_on_resting_hr_and_raw(arch, mon, monkeypatch):
    later = "f" * 64
    assert mon.key < later
    monkeypatch.setattr(wellness, "_PARSERS", dict(wellness._PARSERS))
    real = wellness._PARSERS["monitoring_fit"]

    def parser(data, rec):
        parts = real(data, rec)
        if rec.key == later:
            parts[DAY].stats = {"resting_hr": 61}
            parts[DAY].raw = {"resting_heart_rate": None, "current_day_resting_heart_rate": 61}
        return parts

    wellness.register("monitoring_fit", parser)
    conn = fresh()
    apply_wellness(conn, arch, [_put(arch, fixture_bytes("monitoring.fit"), key=later), mon])
    stats = conn.execute("SELECT resting_hr, raw FROM daily_stats WHERE date=?", (DAY,)).fetchone()
    assert stats["resting_hr"] == 59
    assert json.loads(stats["raw"])["monitoring_fit"] == {"resting_heart_rate": 57,
                                                         "current_day_resting_heart_rate": 59}


def test_reapply_changes_nothing(arch, mon):
    conn = fresh()
    apply_wellness(conn, arch, [mon])
    before = _snapshot(conn)
    assert apply_wellness(conn, arch, [mon]) == 1
    assert _snapshot(conn) == before


@pytest.fixture
def zz_test(monkeypatch):
    monkeypatch.setattr(wellness, "_PARSERS", dict(wellness._PARSERS))
    wellness.register("zz_test", lambda data, rec: {
        DAY: DayPart({"resting_hr": 55, "steps": 9000}, {"x": 1}, {}, None)})


def test_api_source_beats_monitoring_for_stats(arch, mon, zz_test):
    conn = fresh()
    api = _put(arch, b'{"api": 1}', source="zz_test", key=DAY, kind="zz")
    assert apply_wellness(conn, arch, [mon]) == 1
    assert apply_wellness(conn, arch, [api]) == 1     # recomputes the day with the stored FIT input too
    stats = conn.execute("SELECT resting_hr, steps, raw FROM daily_stats WHERE date=?", (DAY,)).fetchone()
    assert stats["resting_hr"] == 55 and stats["steps"] == 9000
    assert set(json.loads(stats["raw"])) == {"monitoring_fit", "zz_test"}
    assert _series(conn)["hr"]["sample_count"] == 193
    assert conn.execute("SELECT kind FROM raw_files WHERE sha256=?", (api.blob_sha256,)).fetchone()[0] == \
        "api_response"


def test_corrupt_input_warns_and_adds_nothing(arch):
    conn = fresh()
    bad = _put(arch, b"not a fit file")
    with pytest.warns(UserWarning, match=f"unreadable wellness input monitoring_fit {bad.key}"):
        assert apply_wellness(conn, arch, [bad]) == 0
    for t in ("wellness_inputs", "daily_stats", "daily_series"):
        assert conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0


def test_input_whose_dates_go_away_clears_the_day(arch, mon):
    conn = fresh()
    apply_wellness(conn, arch, [mon])
    emptied = WellnessRecord(mon.provider, mon.source, mon.key, "2026-10-28T10:00:00+00:00",
                             arch.put_blob(b"broken now"), mon.file_name, mon.origin)
    with pytest.warns(UserWarning, match="unreadable wellness input"):
        assert apply_wellness(conn, arch, [emptied]) == 1
    for t in ("wellness_inputs", "daily_stats", "daily_series"):
        assert conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0
