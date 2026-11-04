import pytest

from ingest.mcp_server.activities import get_activity, list_activities
from ingest.mcp_server.database import Database
from ingest.mcp_server.filters import ActivityFilter
from ingest.tests.mcp_fixture import build_fixture_db


@pytest.fixture
def db(tmp_path):
    d = Database(build_fixture_db(str(tmp_path / "f.sqlite")))
    yield d
    d.close()


def ids_of(result):
    return [r["id"] for r in result["data"]["rows"]]


def row_of(result, id_):
    return next(r for r in result["data"]["rows"] if r["id"] == id_)


def test_default_excludes_hidden(db):
    assert "hidden1" not in ids_of(list_activities(db, ActivityFilter()))


def test_include_hidden(db):
    assert "hidden1" in ids_of(list_activities(db, ActivityFilter(include_hidden=True)))


def test_local_date_range(db):  # run3 starts 2025-12-31 UTC but 2026-01-01 local
    assert ids_of(list_activities(db, ActivityFilter(date_from="2026-01-01"))) == ["run3"]


def test_date_to_inclusive(db):
    assert ids_of(list_activities(db, ActivityFilter(date_from="2025-03-10", date_to="2025-03-10"))) == ["run1"]


def test_types_exact(db):
    assert set(ids_of(list_activities(db, ActivityFilter(types=["Hike"])))) == {"hike1"}


def test_rules_listed(db):
    r = list_activities(db, ActivityFilter(types=["Run"], min_distance_m=1000))
    assert "types: Run" in r["counted"]["rules"]
    assert "distance >= 1000 m" in r["counted"]["rules"]
    assert "visible activities only" in r["counted"]["rules"]


def test_name_contains_case_insensitive(db):
    assert ids_of(list_activities(db, ActivityFilter(name_contains="triglav"))) == ["hike1"]


def test_has_hr(db):
    assert set(ids_of(list_activities(db, ActivityFilter(has_hr=True)))) == {"run1", "run3"}


def test_pace_string(db):
    row = row_of(list_activities(db, ActivityFilter()), "run1")
    assert row["pace_min_km"] == "5:00"
    assert row["distance_km"] == 10.0 and row["moving_min"] == 50.0
    assert row["date_local"] == "2025-03-10"


def test_unknown_values_stay_null(db):
    row = row_of(list_activities(db, ActivityFilter()), "walk1")
    assert row["distance_km"] is None and row["pace_min_km"] is None


def test_sort_distance(db):
    assert ids_of(list_activities(db, ActivityFilter(), sort="distance_desc"))[0] == "hike1"


def test_limit_and_total(db):
    r = list_activities(db, ActivityFilter(), limit=2)
    assert len(r["data"]["rows"]) == 2 and r["data"]["total"] == 6


def test_bad_sort(db):
    with pytest.raises(ValueError):
        list_activities(db, ActivityFilter(), sort="nope")


def test_get_activity_details(db):
    d = get_activity(db, "run1")["data"]
    assert d["sources"][0]["provider"] == "strava"
    assert d["sources"][0]["url"] == "https://www.strava.com/activities/111"
    assert [lap["lap_index"] for lap in d["laps"]] == [0, 1]
    assert d["gear"] == ["Shoe A"]
    assert d["distance"] == 10000


def test_get_activity_hides_private_payloads(db):
    assert "private" not in str(get_activity(db, "run1"))


def test_get_activity_unknown(db):
    with pytest.raises(ValueError):
        get_activity(db, "nope")
