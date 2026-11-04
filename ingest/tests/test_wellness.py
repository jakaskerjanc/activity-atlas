import hashlib
import json

import pytest

from ingest import codec, wellness
from ingest.archive import LocalArchive
from ingest.records import WellnessRecord
from ingest.tests.factories import FETCHED, fixture_bytes, fresh, garmin_heart_rate
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


@pytest.mark.parametrize("shift, expected", [(3600, 61), (-3600, 59)], ids=["later-file-newer", "later-file-older"])
def test_several_fits_on_one_date_take_resting_hr_and_raw_from_the_latest_reading(arch, mon, monkeypatch,
                                                                                    shift, expected):
    other = "f" * 64
    assert mon.key < other
    monkeypatch.setattr(wellness, "_PARSERS", dict(wellness._PARSERS))
    real = wellness._PARSERS["monitoring_fit"]

    def parser(data, rec):
        parts = real(data, rec)
        if rec.key == other:
            parts[DAY].stats = {"resting_hr": 61}
            parts[DAY].raw = {"resting_heart_rate": None, "current_day_resting_heart_rate": 61}
            parts[DAY].observed_s += shift
        return parts

    wellness.register("monitoring_fit", parser)
    conn = fresh()
    apply_wellness(conn, arch, [_put(arch, fixture_bytes("monitoring.fit"), key=other), mon])
    stats = conn.execute("SELECT resting_hr, raw FROM daily_stats WHERE date=?", (DAY,)).fetchone()
    assert stats["resting_hr"] == expected
    raw = json.loads(stats["raw"])["monitoring_fit"]
    assert raw["current_day_resting_heart_rate"] == expected
    assert raw["resting_heart_rate"] == 57      # the newer reading lacks it; a None never overwrites


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


# --- API heart rate next to the monitoring FIT -------------------------------
# monitoring.fit's HR runs from 1775859900 (00:25 local) to 1775878200 (05:30 local), at +02:00

FIT_FIRST, FIT_LAST = 1775859900, 1775878200
LOCAL_MIDNIGHT = 1775858400        # 2026-04-11T00:00+02:00


def _api_hr(arch, values, key=DAY):
    return _put(arch, garmin_heart_rate(key, 7200, values), source="heart_rate", key=key, kind="garmin_api")


def test_monitoring_fit_hr_wins_and_api_hr_fills_only_where_the_fit_has_no_sample(arch, mon):
    api = _api_hr(arch, [(LOCAL_MIDNIGHT, 60),          # 25 min before the FIT's first sample: kept
                         (FIT_FIRST, 99),               # the FIT's own instant: dropped
                         (FIT_FIRST + 150, 99),         # 30 s from a FIT sample: dropped
                         (FIT_LAST + 60, 99),           # dropped
                         (FIT_LAST + 120, 61),          # 120 s from the FIT's last sample: kept
                         (FIT_LAST + 240, None)])       # null: dropped
    conn = fresh()
    apply_wellness(conn, arch, [mon])
    fit_hr = _series(conn)["hr"]
    fit_t, fit_v = codec.decode("time", fit_hr["time"]), codec.decode("hr", fit_hr["data"])
    apply_wellness(conn, arch, [api])
    hr = _series(conn)["hr"]
    assert hr["sample_count"] == 193 + 2 and hr["utc_offset_s"] == 7200
    t, v = codec.decode("time", hr["time"]), codec.decode("hr", hr["data"])
    assert t == [0] + fit_t + [FIT_LAST + 120 + 7200 - (LOCAL_MIDNIGHT + 7200)] and v == [60] + fit_v + [61]
    assert len(set(t)) == len(t)
    assert set(_series(conn)) == {"hr", "stress", "respiration"}


def test_api_hr_alone_fills_the_day(arch):
    conn = fresh()
    apply_wellness(conn, arch, [_api_hr(arch, [(FIT_FIRST, 70), (FIT_FIRST + 120, 71)])])
    hr = _series(conn)["hr"]
    assert codec.decode("time", hr["time"]) == [1500, 1620] and codec.decode("hr", hr["data"]) == [70, 71]


def test_series_do_not_depend_on_input_order_or_reapplying(arch, mon):
    api = _api_hr(arch, [(LOCAL_MIDNIGHT, 60), (FIT_FIRST, 99), (FIT_LAST + 600, 61)])
    one, two = fresh(), fresh()
    apply_wellness(one, arch, [mon, api])
    apply_wellness(two, arch, [api])
    apply_wellness(two, arch, [mon])           # the API input is re-read from wellness_inputs
    assert _snapshot(one) == _snapshot(two)
    apply_wellness(one, arch, [api, mon])
    assert _snapshot(one) == _snapshot(two)
