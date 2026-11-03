"""Garmin Personal API wellness endpoints: one response per endpoint and date,
archived as a wellness record and parsed into daily_stats columns plus the
raw payload. The typed field names were checked against live responses on
2026-11-01 (see ingest/tests/fixtures/garmin_wellness); the raw payload is
always kept, so a corrected mapping only needs a rebuild."""
import json
import time
import warnings
from datetime import date as Date, datetime, timedelta, timezone
from typing import Callable

from .archive import Archive
from .garmin_api import GarminApiError, GarminAuthError
from .records import WellnessRecord
from .wellness import DayPart, register

WELLNESS_REVISE_DAYS = 7
WELLNESS_FIRST_DAYS = 30
MAX_CONSECUTIVE_FAILURES = 3
WELLNESS_BATCH_DAYS = 30

# source -> date -> (path, params)
ENDPOINTS: dict[str, Callable[[str], tuple[str, dict | None]]] = {
    "daily_summary": lambda d: ("/usersummary-service/v2/dailysummaries", {"startDate": d, "endDate": d}),
    "sleep": lambda d: ("/sleep-service/sleep/dailySleep", {"date": d}),
    "hrv": lambda d: (f"/hrv-service/hrv/{d}", None),
    "body_battery": lambda d: ("/wellness-service/wellness/bodyBattery/reports/daily",
                               {"startDate": d, "endDate": d}),
    "stress": lambda d: (f"/usersummary-service/stats/stress/daily/{d}/{d}", None),
    "steps": lambda d: (f"/usersummary-service/stats/steps/daily/{d}/{d}", None),
    "heart_rate": lambda d: ("/wellness-service/wellness/dailyHeartRate", {"date": d}),
    "spo2": lambda d: (f"/wellness-service/wellness/daily/spo2acclimation/{d}", None),
    "weight": lambda d: (f"/weight-service/weight/range/{d}/{d}", {"includeAll": "true"}),
}


def _dig(obj, *path):
    """The value at path through nested dicts and lists, None when absent."""
    for step in path:
        if isinstance(obj, dict):
            obj = obj.get(step)
        elif isinstance(obj, list) and isinstance(step, int) and -len(obj) <= step < len(obj):
            obj = obj[step]
        else:
            return None
    return obj


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _pick(payload, mapping: dict[str, tuple]) -> dict:
    """Column -> value for every mapped field present in the payload with the
    column's type (a string for hrv_status, else a number); anything else is
    left out rather than bound into SQLite."""
    stats = {}
    for column, path in mapping.items():
        value = _dig(payload, *path)
        if isinstance(value, str) if column == "hrv_status" else _number(value):
            stats[column] = value
    return stats


_DAILY_SUMMARY = {"resting_hr": ("heartRate", "restingValue"), "steps": ("movement", "steps", "value"),
                  "stress_avg": ("stress", "avgLevel"),
                  "body_battery_high": ("bodyBattery", "maxValue"),
                  "body_battery_low": ("bodyBattery", "minValue")}
_SLEEP = {"sleep_s": ("sleepTimeSeconds",), "sleep_score": ("sleepScores", "overall", "value")}
_HRV = {"hrv_avg": ("hrvSummary", "lastNightAvg"), "hrv_status": ("hrvSummary", "status")}
_SPO2 = {"spo2_avg": ("averageSpO2",)}


def _entry_for(entries, date_key: str, date: str):
    """The entry of a list response that belongs to ``date``, or None."""
    if not isinstance(entries, list):
        return None
    return next((e for e in entries if isinstance(e, dict) and e.get(date_key) == date), None)


def _daily_summary_stats(payload, date: str) -> dict:
    return _pick(_entry_for(_dig(payload, "data"), "calendarDate", date), _DAILY_SUMMARY)


def _weight_stats(payload, date: str) -> dict:
    # previousDateWeight / nextDateWeight belong to other days
    grams = _dig(_entry_for(_dig(payload, "dailyWeightSummaries"), "summaryDate", date), "latestWeight", "weight")
    return {"weight_kg": grams / 1000} if _number(grams) else {}


def _parser(source: str, stats: Callable[[object, str], dict]):
    def parse(data: bytes, rec: WellnessRecord) -> dict[str, DayPart]:
        try:
            payload = json.loads(data)
        except ValueError as e:
            warnings.warn(f"unparseable {source} response for {rec.key}: {e}")
            return {}
        return {rec.key: DayPart(stats(payload, rec.key), payload, {}, None)}
    return parse


_STATS: dict[str, Callable[[object, str], dict]] = {
    "daily_summary": _daily_summary_stats,
    "sleep": lambda payload, date: _pick(payload, _SLEEP),
    "hrv": lambda payload, date: _pick(payload, _HRV),
    "weight": _weight_stats,
    "spo2": lambda payload, date: _pick(payload, _SPO2),
}
for _source in ENDPOINTS:    # the rest are raw only
    register(_source, _parser(_source, _STATS.get(_source, lambda payload, date: {})))


def _start_dates(conn, today: Date, since: str | None) -> dict[str, Date]:
    """The first date to fetch for each endpoint. ``since`` applies to all.
    Otherwise an endpoint revises the WELLNESS_REVISE_DAYS before its own last
    stored day, so days it missed while skipped are fetched again. An endpoint
    with nothing stored, or far behind, reaches back at most WELLNESS_FIRST_DAYS
    before the window of the endpoints that are current."""
    if since:
        return dict.fromkeys(ENDPOINTS, Date.fromisoformat(since))
    marks = ", ".join("?" * len(ENDPOINTS))
    last = {source: Date.fromisoformat(d) for source, d in conn.execute(
        f"SELECT source, MAX(date) FROM wellness_inputs WHERE provider='garmin' AND source IN ({marks}) "
        "GROUP BY source", tuple(ENDPOINTS))}
    if not last:
        return dict.fromkeys(ENDPOINTS, today - timedelta(days=WELLNESS_FIRST_DAYS))
    revise = timedelta(days=WELLNESS_REVISE_DAYS)
    floor = max(last.values()) - revise - timedelta(days=WELLNESS_FIRST_DAYS)
    starts = {}
    for source in ENDPOINTS:
        if source not in last:
            starts[source] = floor
            continue
        starts[source] = max(last[source] - revise, floor)
        if last[source] - revise < floor:
            warnings.warn(f"wellness {source} was last stored for {last[source]}; fetching from {floor}. "
                          f"Run with --wellness-since {last[source] - revise} to fill the gap")
    return starts


def fetch_wellness(client, archive: Archive, conn, *, now: str, since: str | None = None,
                   until: str | None = None, delay_s: float = 1.0,
                   on_batch: Callable[[list[WellnessRecord]], None] | None = None) -> list[WellnessRecord]:
    """Fetch every endpoint for each date from its start (see _start_dates)
    through ``until`` (default and latest: today), archive each response and
    return its record. An endpoint
    that fails 3 times in a row is skipped for the rest of the run; an auth
    error aborts. ``on_batch`` receives the records of every
    WELLNESS_BATCH_DAYS days as they complete, and the rest at the end."""
    today = datetime.fromisoformat(now).astimezone(timezone.utc).date()
    starts = _start_dates(conn, today, since)
    last = min(today, Date.fromisoformat(until)) if until else today
    day = min(starts.values())
    failures = dict.fromkeys(ENDPOINTS, 0)
    records, batch, batch_days = [], [], 0
    while day <= last:
        current, date = day, day.isoformat()
        day += timedelta(days=1)
        if on_batch and batch_days == WELLNESS_BATCH_DAYS:
            on_batch(batch)
            batch, batch_days = [], 0
        batch_days += 1
        for source, endpoint in ENDPOINTS.items():
            if current < starts[source] or failures[source] >= MAX_CONSECUTIVE_FAILURES:
                continue
            path, params = endpoint(date)
            try:
                body = client.get_raw(path, params)
            except GarminAuthError:
                raise
            except GarminApiError as e:
                failures[source] += 1
                warnings.warn(f"wellness {source} {date} failed: {e}")
                if failures[source] >= MAX_CONSECUTIVE_FAILURES:
                    warnings.warn(f"wellness endpoint {source} failed {MAX_CONSECUTIVE_FAILURES} times "
                                  "in a row; skipping it this run")
                continue
            finally:
                time.sleep(delay_s)
            failures[source] = 0
            if not body:
                continue
            sha = archive.put_blob(body)
            try:
                json.loads(body)
            except ValueError:
                # a later non-JSON 200 must not replace the day's stored input
                warnings.warn(f"wellness endpoint {source} returned invalid JSON for {date}; "
                              "archived, not applied")
                continue
            rec = WellnessRecord("garmin", source, date, now, sha, None,
                                 {"kind": "garmin_api", "path": path})
            archive.put_wellness(rec)
            records.append(rec)
            batch.append(rec)
    if on_batch:
        on_batch(batch)
    return records
