import json

import pytest

from ingest import garmin_wellness as gw
from ingest.archive import LocalArchive
from ingest.garmin_api import GarminApiError
from ingest.tests.factories import fresh
from ingest.wellness import apply_wellness

NOW = "2026-10-27T10:00:00+00:00"
SUMMARY = "/usersummary-service/v2/dailysummaries"


class FakeClient:
    def __init__(self, wellness=None):
        self.wellness, self.calls = wellness or {}, []

    def get_raw(self, path, params=None):
        self.calls.append((path, params))
        result = self.wellness.get(path, b"")
        if isinstance(result, Exception):
            raise result
        return result(params) if callable(result) else result


@pytest.fixture
def arch(tmp_path):
    return LocalArchive(str(tmp_path / "arch"))


def _fetch(client, arch, conn, now=NOW, **kw):
    return gw.fetch_wellness(client, arch, conn, now=now, delay_s=0, **kw)


def _dates(client, path):
    return sorted({p["startDate"] for c, p in client.calls if c == path})


def _summary(date, **fields):
    return json.dumps([{"calendarDate": date, **fields}]).encode()


def test_first_run_fetches_30_days_of_every_endpoint(arch):
    client = FakeClient()
    assert _fetch(client, arch, fresh()) == []
    assert len(client.calls) == 31 * 9
    assert client.calls[0] == (SUMMARY, {"startDate": "2026-09-27", "endDate": "2026-09-27"})
    assert _dates(client, SUMMARY)[0] == "2026-09-27" and _dates(client, SUMMARY)[-1] == "2026-10-27"
    assert len(_dates(client, SUMMARY)) == 31


def test_next_run_refetches_last_7_days(arch):
    conn = fresh()
    first = FakeClient({SUMMARY: lambda p: _summary(p["startDate"], restingHeartRate=52)
                        if p["startDate"] == "2026-10-27" else b""})
    apply_wellness(conn, arch, _fetch(first, arch, conn))
    client = FakeClient()
    _fetch(client, arch, conn, now="2026-10-29T10:00:00+00:00")
    dates = _dates(client, SUMMARY)
    assert dates[0] == "2026-10-20" and dates[-1] == "2026-10-29" and len(dates) == 10


def test_wellness_since_overrides_start(arch):
    conn = fresh()
    first = FakeClient({SUMMARY: lambda p: _summary(p["startDate"]) if p["startDate"] == "2026-10-27" else b""})
    apply_wellness(conn, arch, _fetch(first, arch, conn))
    client = FakeClient()
    _fetch(client, arch, conn, now="2026-10-29T10:00:00+00:00", since="2026-10-01")
    dates = _dates(client, SUMMARY)
    assert dates[0] == "2026-10-01" and dates[-1] == "2026-10-29" and len(dates) == 29


def test_daily_summary_maps_typed_columns_and_keeps_raw(arch):
    conn = fresh()
    payload = [{"calendarDate": "2026-10-27", "restingHeartRate": 52, "totalSteps": 12000}]
    client = FakeClient({SUMMARY: lambda p: json.dumps(payload).encode() if p["startDate"] == "2026-10-27" else b""})
    records = _fetch(client, arch, conn)
    assert [(r.source, r.key) for r in records] == [("daily_summary", "2026-10-27")]
    assert records[0].origin == {"kind": "garmin_api", "path": SUMMARY}
    assert apply_wellness(conn, arch, records) == 1
    row = conn.execute("SELECT * FROM daily_stats WHERE date='2026-10-27'").fetchone()
    assert row["resting_hr"] == 52 and row["steps"] == 12000 and row["stress_avg"] is None
    assert json.loads(row["raw"])["daily_summary"] == payload


def test_other_endpoints_map_their_typed_columns(arch):
    conn = fresh()
    day = "2026-10-27"
    wellness = {
        "/sleep-service/sleep/dailySleep": json.dumps(
            {"dailySleepDTO": {"sleepTimeSeconds": 27000, "sleepScores": {"overall": {"value": 81}}}}).encode(),
        f"/hrv-service/hrv/{day}": json.dumps({"hrvSummary": {"lastNightAvg": 44, "status": "BALANCED"}}).encode(),
        f"/weight-service/weight/range/{day}/{day}": json.dumps({"dateWeightList": [{"weight": 71500}]}).encode(),
        f"/wellness-service/wellness/daily/spo2acclimation/{day}": json.dumps({"averageSpO2": 95}).encode(),
        f"/usersummary-service/stats/steps/daily/{day}/{day}": b'[{"totalSteps": 1}]',
    }
    client = FakeClient({p: (lambda b: lambda params: b if not params or params.get("date", day) == day else b"")(b)
                         for p, b in wellness.items()})
    apply_wellness(conn, arch, _fetch(client, arch, conn, since=day))
    row = conn.execute("SELECT * FROM daily_stats WHERE date=?", (day,)).fetchone()
    assert (row["sleep_s"], row["sleep_score"], row["hrv_avg"], row["hrv_status"]) == (27000, 81, 44, "BALANCED")
    assert (row["weight_kg"], row["spo2_avg"]) == (71.5, 95)
    assert row["steps"] is None                     # the steps endpoint is raw only
    assert set(json.loads(row["raw"])) == {"sleep", "hrv", "weight", "spo2", "steps"}


def test_daily_summary_dict_payload_and_other_dates_ignored(arch):
    conn = fresh()
    day = "2026-10-27"
    other = json.dumps([{"calendarDate": "2026-10-26", "totalSteps": 1},
                        {"calendarDate": day, "totalSteps": 7}]).encode()
    client = FakeClient({SUMMARY: other})
    apply_wellness(conn, arch, _fetch(client, arch, conn, since=day))
    assert conn.execute("SELECT steps FROM daily_stats WHERE date=?", (day,)).fetchone()[0] == 7
    assert gw._daily_summary_stats({"totalSteps": 3}, day) == {"steps": 3}


def test_revised_day_replaces_value(tmp_path, arch):
    conn = fresh()
    day = "2026-10-27"
    for value in (52, 50):
        client = FakeClient({SUMMARY: lambda p, v=value: _summary(day, restingHeartRate=v)
                             if p["startDate"] == day else b""})
        apply_wellness(conn, arch, _fetch(client, arch, conn, now="2026-10-27T10:00:00+00:00" if value == 52
                                          else "2026-10-27T18:00:00+00:00"))
    assert conn.execute("SELECT resting_hr FROM daily_stats WHERE date=?", (day,)).fetchone()[0] == 50
    assert len(list((tmp_path / "arch" / "wellness" / "garmin" / "daily_summary" / day).glob("*.json"))) == 2


def test_failing_endpoint_is_skipped_after_three_failures(arch):
    client = FakeClient({"/hrv-service/hrv/" + f"2026-09-{d}": GarminApiError("x", status=400) for d in range(27, 31)}
                        | {"/hrv-service/hrv/" + f"2026-10-{d:02d}": GarminApiError("x", status=400)
                           for d in range(1, 28)})
    with pytest.warns(UserWarning) as caught:
        _fetch(client, arch, fresh())
    paths = [c[0] for c in client.calls]
    assert sum(p.startswith("/hrv-service/") for p in paths) == 3
    assert paths.count(SUMMARY) == 31 and paths.count("/sleep-service/sleep/dailySleep") == 31
    messages = [str(w.message) for w in caught]
    assert "wellness endpoint hrv failed 3 times in a row; skipping it this run" in messages
    assert sum("hrv" in m for m in messages) == 4      # three failures, then the skip notice


def test_success_resets_the_failure_count(arch):
    day = lambda d: f"/hrv-service/hrv/2026-10-{d:02d}"
    wellness = {day(d): GarminApiError("x", status=500) for d in (20, 21, 23, 24)}
    wellness[day(22)] = b"{}"
    client = FakeClient(wellness)
    with pytest.warns(UserWarning):
        _fetch(client, arch, fresh(), since="2026-10-20")
    assert sum(p.startswith("/hrv-service/") for p, _ in client.calls) == 8   # never three in a row


def test_unparseable_body_is_archived_and_adds_nothing(arch):
    conn = fresh()
    day = "2026-10-27"
    client = FakeClient({f"/hrv-service/hrv/{day}": b"not json"})
    records = _fetch(client, arch, conn, since=day)
    assert arch.get_blob(records[0].blob_sha256) == b"not json"
    with pytest.warns(UserWarning, match="hrv"):
        assert apply_wellness(conn, arch, records) == 0
    assert conn.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM wellness_inputs").fetchone()[0] == 0
