import sqlite3

import pytest

from ingest.mcp_server.activities import get_activity, list_activities, places, same_route, summarize
from ingest.mcp_server.database import Database
from ingest.mcp_server.filters import NO_PLACES_YET, ActivityFilter, fold_name, where_sql
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
    assert set(ids_of(list_activities(db, ActivityFilter(types=["Hike"])))) == {
        "hike1", "slavnik1", "slavnik2", "smarna1", "grmada1", "grmada2"}


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
    assert len(r["data"]["rows"]) == 2 and r["data"]["total"] == 11


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


def test_pace_is_total_time_over_total_distance(db):
    r = summarize(db, ActivityFilter(types=["Run"], date_from="2025-03-01", date_to="2025-03-31"), period="month")
    row = r["data"]["rows"][0]
    # run1 3000 s / 10 km + run2 1500 s / 5 km = 4500 s / 15 km = 5:00; run_nomove is left out
    assert row["period"] == "2025-03" and row["type"] == "Run"
    assert row["pace_min_km"] == "5:00" and row["pace_basis_count"] == 2 and row["count"] == 3
    assert row["speed_kmh"] == 12.0
    assert r["counted"]["excluded"]["no distance or moving time (pace)"] == 1


def test_hr_weighted_by_moving_time(db):
    row = summarize(db, ActivityFilter(types=["Run"], date_to="2025-03-31"), period="all")["data"]["rows"][0]
    assert row["avg_hr"] == 150 and row["hr_known"] == 1


def test_hr_weighting_across_runs(db):  # run1 150 bpm x 3000 s, run3 140 bpm x 2400 s
    row = summarize(db, ActivityFilter(types=["Run"]), period="all")["data"]["rows"][0]
    assert row["avg_hr"] == round((150 * 3000 + 140 * 2400) / 5400, 1)


def test_year_uses_local_date(db):
    years = {r["period"] for r in summarize(db, ActivityFilter(types=["Run"]), period="year")["data"]["rows"]}
    assert years == {"2025", "2026"}


def test_week_starts_monday(db):  # 2025-03-12 is a Wednesday
    rows = summarize(db, ActivityFilter(types=["Run"], date_from="2025-03-12", date_to="2025-03-12"),
                     period="week")["data"]["rows"]
    assert rows[0]["period"] == "2025-03-10"


def test_unknown_distance_not_zero(db):
    row = summarize(db, ActivityFilter(types=["Walk"]), period="all")["data"]["rows"][0]
    assert row["count"] == 1 and row["distance_known"] == 0 and row["distance_km"] is None


def test_by_type_false_merges_types(db):
    rows = summarize(db, ActivityFilter(date_from="2025-03-01", date_to="2025-03-31"), period="month",
                     by_type=False)["data"]["rows"]
    assert len(rows) == 1 and rows[0]["count"] == 4 and "type" not in rows[0]


def test_summarize_rules_state_definitions(db):
    rules = summarize(db, ActivityFilter(types=["Run"]))["counted"]["rules"]
    assert any("total moving time / total distance" in r for r in rules)
    assert any("Monday" in r or "local start date" in r for r in rules)


def test_bad_period(db):
    with pytest.raises(ValueError):
        summarize(db, ActivityFilter(), period="decade")


def test_place_filter_by_id_and_name(db):
    for place in ("slavnik1", "Slavnik"):
        r = list_activities(db, ActivityFilter(place=place))
        assert ids_of(r) == ["slavnik2", "slavnik1"]
        assert f"place: {place}" in r["counted"]["rules"]


def test_place_filter_ignores_case_and_accents(db):
    for place in ("šmarna gora", "smarna gora", "ŠMARNA GORA"):
        assert ids_of(list_activities(db, ActivityFilter(place=place))) == ["smarna1"]
    assert fold_name("Šmarna gora") == fold_name("smarna gora") == "smarna gora"


def test_place_filter_rule_mentions_duplicates(db):
    r = list_activities(db, ActivityFilter(place="Grmada"))
    assert ids_of(r) == ["grmada2", "grmada1"]
    assert "place: Grmada (2 places with that name)" in r["counted"]["rules"]


def test_place_filter_in_summarize(db):
    r = summarize(db, ActivityFilter(place="Slavnik"), period="all")
    assert r["data"]["rows"][0]["count"] == 2 and "place: Slavnik" in r["counted"]["rules"]


def test_unknown_place_points_to_places_tool(db):
    with pytest.raises(ValueError, match="places tool"):
        list_activities(db, ActivityFilter(place="Nowhere"))


def test_where_sql_refuses_an_unresolved_place():
    with pytest.raises(RuntimeError):
        where_sql(ActivityFilter(place="Slavnik"))


def test_places_lists_counts(db):
    r = places(db)
    assert [(p["id"], p["name"], p["count"]) for p in r["data"]["places"]] == [
        ("slavnik1", "Slavnik", 2), ("grmada1", "Grmada", 1), ("grmada2", "Grmada", 1),
        ("smarna1", "Šmarna gora", 1)]
    assert r["data"]["places"][0] == {"id": "slavnik1", "name": "Slavnik", "name_source": "osm",
                                      "kind": "peak", "ele": 1028, "count": 2}
    assert r["counted"] == {"rules": ["visible activities only"], "included": 4, "excluded": {}}


def test_same_route_includes_self_newest_first(db):
    for id_ in ("slavnik1", "slavnik2"):
        r = same_route(db, id_)
        assert r["data"]["route"] == {"id": "slavnik1", "name": "Slavnik out-and-back"}
        assert [a["id"] for a in r["data"]["activities"]] == ["slavnik2", "slavnik1"]
        assert r["counted"]["included"] == 2
    row = r["data"]["activities"][1]
    assert row == list_activities(db, ActivityFilter(place="Slavnik"))["data"]["rows"][1]


def test_same_route_none_for_one_off(db):
    r = same_route(db, "run2")
    assert r["data"]["route"] is None
    assert [a["id"] for a in r["data"]["activities"]] == ["run2"]


def test_same_route_unknown_activity(db):
    with pytest.raises(ValueError, match="no activity nope"):
        same_route(db, "nope")


def test_without_group_tables_says_no_places_yet(tmp_path):
    path = build_fixture_db(str(tmp_path / "v4.sqlite"))
    conn = sqlite3.connect(path)
    for table in ("places", "route_groups", "activity_groups"):
        conn.execute(f"DROP TABLE {table}")
    conn.commit()
    conn.close()
    d = Database(path)
    try:
        for call in (lambda: places(d), lambda: same_route(d, "slavnik1"),
                     lambda: list_activities(d, ActivityFilter(place="Slavnik")),
                     lambda: summarize(d, ActivityFilter(place="Slavnik"))):
            with pytest.raises(ValueError, match=NO_PLACES_YET):
                call()
        assert list_activities(d, ActivityFilter())["data"]["total"] == 11
    finally:
        d.close()
