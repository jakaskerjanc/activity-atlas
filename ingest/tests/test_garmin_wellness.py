import hashlib
import json

import pytest
from datetime import datetime, timezone
from pathlib import Path

from ingest import codec, garmin_wellness as gw, wellness
from ingest.archive import LocalArchive
from ingest.garmin_api import GarminApiError
from ingest.records import WellnessRecord
from ingest.tests.factories import fresh, garmin_heart_rate
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


def _summary(date, resting_hr=None, **entry):
    """A daily summary in the real v2 shape."""
    return json.dumps({"data": [{"calendarDate": date, "heartRate": {"restingValue": resting_hr}, **entry}]}).encode()


FIXTURES = Path(__file__).parent / "fixtures" / "garmin_wellness"


def _fixture(name):
    """A real API response for one day: ids removed, lists cut to 2, numbers made up."""
    return (FIXTURES / f"{name}.json").read_bytes()


def _one_day(day, bodies):
    """Endpoint path -> body for ``day``; every other date gets no body."""
    def serve(path, body):
        return lambda params: body if day in path or day in (params or {}).values() else b""
    paths = {source: gw.ENDPOINTS[source](day)[0] for source in bodies}
    return {paths[source]: serve(paths[source], body) for source, body in bodies.items()}


def test_first_run_fetches_30_days_of_every_endpoint(arch):
    client = FakeClient()
    assert _fetch(client, arch, fresh()) == []
    assert len(client.calls) == 31 * 9
    assert client.calls[0] == (SUMMARY, {"startDate": "2026-09-27", "endDate": "2026-09-27"})
    assert _dates(client, SUMMARY)[0] == "2026-09-27" and _dates(client, SUMMARY)[-1] == "2026-10-27"
    assert len(_dates(client, SUMMARY)) == 31


def test_next_run_refetches_last_7_days(arch):
    conn = fresh()
    first = FakeClient({SUMMARY: lambda p: _summary(p["startDate"], resting_hr=52)
                        if p["startDate"] == "2026-10-27" else b""})
    apply_wellness(conn, arch, _fetch(first, arch, conn))
    client = FakeClient()
    _fetch(client, arch, conn, now="2026-10-29T10:00:00+00:00")
    dates = _dates(client, SUMMARY)
    assert dates[0] == "2026-10-20" and dates[-1] == "2026-10-29" and len(dates) == 10


def test_wellness_until_ends_the_range(arch):
    client = FakeClient()
    _fetch(client, arch, fresh(), now="2026-10-29T10:00:00+00:00", since="2026-10-01", until="2026-10-05")
    assert _dates(client, SUMMARY) == ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]


def test_wellness_until_after_today_stops_at_today(arch):
    client = FakeClient()
    _fetch(client, arch, fresh(), now="2026-10-29T10:00:00+00:00", since="2026-10-28", until="2026-12-01")
    assert _dates(client, SUMMARY) == ["2026-10-28", "2026-10-29"]


def test_wellness_since_overrides_start(arch):
    conn = fresh()
    first = FakeClient({SUMMARY: lambda p: _summary(p["startDate"]) if p["startDate"] == "2026-10-27" else b""})
    apply_wellness(conn, arch, _fetch(first, arch, conn))
    client = FakeClient()
    _fetch(client, arch, conn, now="2026-10-29T10:00:00+00:00", since="2026-10-01")
    dates = _dates(client, SUMMARY)
    assert dates[0] == "2026-10-01" and dates[-1] == "2026-10-29" and len(dates) == 29


def test_real_daily_summary_maps_typed_columns_and_keeps_raw(arch):
    conn, day = fresh(), "2026-10-30"
    records = _fetch(FakeClient(_one_day(day, {"daily_summary": _fixture("daily_summary")})), arch, conn, since=day,
                     now="2026-10-30T10:00:00+00:00")
    assert [(r.source, r.key) for r in records] == [("daily_summary", day)]
    assert records[0].origin == {"kind": "garmin_api", "path": SUMMARY}
    assert apply_wellness(conn, arch, records) == 1
    row = conn.execute("SELECT * FROM daily_stats WHERE date=?", (day,)).fetchone()
    assert (row["resting_hr"], row["steps"], row["stress_avg"], row["body_battery_high"],
            row["body_battery_low"]) == (55, 8000, 25, 80, 15)
    assert json.loads(row["raw"])["daily_summary"] == json.loads(_fixture("daily_summary"))


def test_real_responses_of_the_other_endpoints_map_their_typed_columns(arch):
    conn, day = fresh(), "2026-10-30"
    bodies = {source: _fixture(source) for source in ("sleep", "hrv", "spo2")}
    bodies["steps"] = b'[{"calendarDate": "2026-10-30", "totalSteps": 1}]'
    apply_wellness(conn, arch, _fetch(FakeClient(_one_day(day, bodies)), arch, conn, since=day,
                                      now="2026-10-30T10:00:00+00:00"))
    row = conn.execute("SELECT * FROM daily_stats WHERE date=?", (day,)).fetchone()
    assert (row["sleep_s"], row["sleep_score"], row["hrv_avg"], row["hrv_status"]) == (27000, 75, 40, "BALANCED")
    assert row["spo2_avg"] is None                  # pulse ox was off: averageSpO2 is null
    assert row["steps"] is None                     # the steps endpoint is raw only
    assert set(json.loads(row["raw"])) == {"sleep", "hrv", "spo2", "steps"}


def test_weight_is_the_days_latest_weigh_in_only(arch):
    conn = fresh()
    for day, name in (("2026-10-25", "weight"), ("2026-10-24", "weight_none")):
        apply_wellness(conn, arch, _fetch(FakeClient(_one_day(day, {"weight": _fixture(name)})), arch, conn,
                                          since=day, now="2026-10-25T10:00:00+00:00"))
    weights = dict(conn.execute("SELECT date, weight_kg FROM daily_stats WHERE date IN ('2026-10-24', '2026-10-25')"))
    assert weights == {"2026-10-25": 70.0, "2026-10-24": None}   # not the neighbouring days' weights


def test_daily_summary_takes_its_own_date_and_empty_days_add_no_values(arch):
    day = "2026-10-27"
    other = json.dumps({"data": [{"calendarDate": "2026-10-26", "movement": {"steps": {"value": 1}}},
                                 {"calendarDate": day, "movement": {"steps": {"value": 7}}}]}).encode()
    assert gw._daily_summary_stats(json.loads(other), day) == {"steps": 7}
    assert gw._daily_summary_stats(json.loads(_fixture("daily_summary_empty")), day) == {}


def test_revised_day_replaces_value(tmp_path, arch):
    conn = fresh()
    day = "2026-10-27"
    for value in (52, 50):
        client = FakeClient({SUMMARY: lambda p, v=value: _summary(day, resting_hr=v)
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


SLEEP = "/sleep-service/sleep/dailySleep"


def test_endpoint_skipped_in_one_run_catches_up_in_the_next(arch):
    conn = fresh()
    down = {"2026-09-27", "2026-09-28", "2026-09-29"}   # sleep fails these, then is skipped for the run

    def sleep(p):
        if p["date"] in down:
            raise GarminApiError("x", status=500)
        return b'{"sleepTimeSeconds": null}'
    first = FakeClient({SUMMARY: lambda p: _summary(p["startDate"], resting_hr=52), SLEEP: sleep})
    with pytest.warns(UserWarning):
        apply_wellness(conn, arch, _fetch(first, arch, conn))
    assert not any(c == SLEEP and p["date"] == "2026-09-30" for c, p in first.calls)

    down.clear()
    client = FakeClient({SLEEP: sleep})
    _fetch(client, arch, conn, now="2026-10-28T10:00:00+00:00")
    sleep_dates = sorted(p["date"] for c, p in client.calls if c == SLEEP)
    assert sleep_dates[0] <= "2026-09-27" and sleep_dates[-1] == "2026-10-28"
    assert _dates(client, SUMMARY)[0] == "2026-10-20"      # endpoints that are current still revise 7 days


def test_endpoint_far_behind_is_capped_with_a_warning(arch):
    conn = fresh()
    first = FakeClient({SUMMARY: lambda p: _summary(p["startDate"]),
                        SLEEP: lambda p: b"{}" if p["date"] == "2026-08-01" else b""})
    apply_wellness(conn, arch, _fetch(first, arch, conn, since="2026-08-01"))
    client = FakeClient()
    with pytest.warns(UserWarning, match="sleep.*--wellness-since"):
        _fetch(client, arch, conn, now="2026-10-28T10:00:00+00:00")
    sleep_dates = sorted(p["date"] for c, p in client.calls if c == SLEEP)
    assert sleep_dates[0] == "2026-09-20"     # 30 days before the 7-day revise window of the others


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
    with pytest.warns(UserWarning, match="hrv returned invalid JSON for 2026-10-27; archived, not applied"):
        assert _fetch(client, arch, conn, since=day) == []
    assert arch.has_blob(hashlib.sha256(b"not json").hexdigest())
    assert arch.list_wellness() == []


def test_unparseable_response_keeps_the_days_stored_data(tmp_path, arch):
    conn = fresh()
    day = "2026-10-27"
    good = FakeClient({SUMMARY: _summary(day, resting_hr=52)})
    apply_wellness(conn, arch, _fetch(good, arch, conn, since=day))
    garbage = b"<html>maintenance</html>"
    bad = FakeClient({SUMMARY: garbage})
    with pytest.warns(UserWarning, match="daily_summary returned invalid JSON"):
        records = _fetch(bad, arch, conn, now="2026-10-27T18:00:00+00:00", since=day)
    assert apply_wellness(conn, arch, records) == 0
    assert conn.execute("SELECT resting_hr FROM daily_stats WHERE date=?", (day,)).fetchone()[0] == 52
    assert arch.has_blob(hashlib.sha256(garbage).hexdigest())
    assert len(list((tmp_path / "arch" / "wellness" / "garmin" / "daily_summary" / day).glob("*.json"))) == 1


def test_wrongly_typed_fields_stay_none(arch):
    conn = fresh()
    day = "2026-10-27"
    client = FakeClient({
        SUMMARY: _summary(day, resting_hr={"value": 52}, movement={"steps": {"value": True}},
                          stress={"avgLevel": "high"}),
        f"/hrv-service/hrv/{day}": json.dumps({"hrvSummary": {"lastNightAvg": [44], "status": {"x": 1}}}).encode(),
    })
    apply_wellness(conn, arch, _fetch(client, arch, conn, since=day))
    row = conn.execute("SELECT * FROM daily_stats WHERE date=?", (day,)).fetchone()
    assert (row["resting_hr"], row["steps"], row["stress_avg"], row["hrv_avg"], row["hrv_status"]) == (None,) * 5
    assert json.loads(row["raw"])["daily_summary"]["data"][0]["heartRate"]["restingValue"] == {"value": 52}


# --- intraday series from heart_rate and hrv -------------------------------

def _parts(source, body, day="2026-10-30"):
    rec = WellnessRecord("garmin", source, day, "", "sha", None, {})
    return wellness._parser(rec)(body, rec)


def _unix(iso):
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp())


def test_heart_rate_values_become_the_days_hr_series_without_nulls():
    parts = _parts("heart_rate", _fixture("heart_rate"))
    assert set(parts) == {"2026-10-30"}
    p = parts["2026-10-30"]
    assert p.series == {"hr": [(_unix("2026-10-29T23:00:00"), 61), (_unix("2026-10-29T23:04:00"), 58),
                               (_unix("2026-10-30T22:58:00"), 66)]}      # the null at 23:02 is dropped
    assert p.utc_offset_s == 3600
    assert p.stats == {} and p.raw == json.loads(_fixture("heart_rate"))


def test_hrv_readings_become_the_hrv_series_of_their_local_date():
    parts = _parts("hrv", _fixture("hrv"))
    assert set(parts) == {"2026-10-30"}
    p = parts["2026-10-30"]
    assert p.series == {"hrv": [(_unix("2026-10-29T23:56:22"), 48), (_unix("2026-10-30T00:01:22"), 13)]}
    assert p.utc_offset_s == 3600 and p.stats["hrv_avg"] == 40


def test_hrv_reading_before_local_midnight_belongs_to_the_previous_date():
    payload = json.loads(_fixture("hrv"))
    payload["hrvReadings"].insert(0, {"hrvValue": 55, "readingTimeGMT": "2026-10-29T22:50:00.0",
                                      "readingTimeLocal": "2026-10-29T23:50:00.0"})
    parts = _parts("hrv", json.dumps(payload).encode())
    assert set(parts) == {"2026-10-29", "2026-10-30"}
    prev = parts["2026-10-29"]
    assert prev.series == {"hrv": [(_unix("2026-10-29T22:50:00"), 55)]} and prev.utc_offset_s == 3600
    assert prev.stats == {} and prev.raw is None          # the night's figures stay on the response's date
    assert len(parts["2026-10-30"].series["hrv"]) == 2


def test_heart_rate_sample_past_the_days_end_goes_to_the_next_local_date():
    body = garmin_heart_rate("2026-10-30", 3600, [(_unix("2026-10-30T22:58:00"), 66),
                                                  (_unix("2026-10-30T23:00:00"), 70)])
    parts = _parts("heart_rate", body)
    assert set(parts) == {"2026-10-30", "2026-10-31"}
    assert parts["2026-10-31"].series == {"hr": [(_unix("2026-10-30T23:00:00"), 70)]}
    assert parts["2026-10-31"].raw is None and parts["2026-10-31"].utc_offset_s == 3600


def test_heart_rate_on_a_dst_change_day_stays_on_its_date(arch):
    # 2026-10-25 runs from 00:00 CEST (22:00Z the day before) to 24:00 CET (23:00Z): 25 hours
    payload = json.loads(garmin_heart_rate("2026-10-25", 7200, [(_unix("2026-10-25T22:58:00"), 64)]))
    payload["endTimestampGMT"] = "2026-10-25T23:00:00.0"
    body = json.dumps(payload).encode()
    assert set(_parts("heart_rate", body, "2026-10-25")) == {"2026-10-25"}
    conn = fresh()
    sha = arch.put_blob(body)
    apply_wellness(conn, arch, [WellnessRecord("garmin", "heart_rate", "2026-10-25", NOW, sha, None, {})])
    row = conn.execute("SELECT * FROM daily_series WHERE channel='hr'").fetchone()
    # the time of day counts the seconds since local midnight, so the 25-hour day's last hour runs past 86400
    assert (row["date"], row["utc_offset_s"], codec.decode("time", row["time"])) == ("2026-10-25", 7200, [89880])


def test_malformed_intraday_entries_are_skipped():
    hr = json.loads(_fixture("heart_rate"))
    t = hr["heartRateValues"][0][0]
    hr["heartRateValues"] = [None, [t], ["x", 60], [t, "60"], [t, True], [t, 0], [t + 120000, 59]]
    assert _parts("heart_rate", json.dumps(hr).encode())["2026-10-30"].series == {"hr": [(t // 1000 + 120, 59)]}
    hr["heartRateValues"] = None                         # a day the watch was not worn
    p = _parts("heart_rate", json.dumps(hr).encode())["2026-10-30"]
    assert p.series == {} and p.utc_offset_s is None and p.raw == hr
    hrv = json.loads(_fixture("hrv"))
    hrv["hrvReadings"] = [{"hrvValue": None, "readingTimeGMT": "2026-10-29T23:56:22.0",
                           "readingTimeLocal": "2026-10-30T00:56:22.0"},
                          {"hrvValue": 50, "readingTimeGMT": "bad", "readingTimeLocal": "2026-10-30T00:56:22.0"},
                          {"hrvValue": 51}, "x"]
    assert _parts("hrv", json.dumps(hrv).encode())["2026-10-30"].series == {}


def test_api_heart_rate_and_hrv_fill_daily_series(arch):
    conn = fresh()
    day = "2026-10-30"
    apply_wellness(conn, arch, _fetch(FakeClient(_one_day(day, {"heart_rate": _fixture("heart_rate"),
                                                                "hrv": _fixture("hrv")})),
                                      arch, conn, now="2026-10-30T10:00:00+00:00"))
    rows = {r["channel"]: r for r in conn.execute("SELECT * FROM daily_series WHERE date=?", (day,))}
    assert set(rows) == {"hr", "hrv"}
    hr, hrv = rows["hr"], rows["hrv"]
    assert hr["sample_count"] == 3 and hr["utc_offset_s"] == 3600
    assert codec.decode("time", hr["time"]) == [0, 240, 86280]
    assert codec.decode("hr", hr["data"]) == [61, 58, 66]
    assert codec.decode("time", hrv["time"]) == [3382, 3682]          # 00:56:22 and 01:01:22 local
    assert codec.decode("hrv", hrv["data"]) == [48, 13]
