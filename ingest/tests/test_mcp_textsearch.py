import shutil
import sqlite3

import pytest

from ingest import writer
from ingest.mcp_server.activities import list_activities
from ingest.mcp_server.database import Database, QueryError, run_query
from ingest.mcp_server.filters import ActivityFilter
from ingest.mcp_server.textsearch import search_texts, split_type, words_match
from ingest.tests.mcp_fixture import build_fixture_db


@pytest.fixture
def db(tmp_path):
    d = Database(build_fixture_db(str(tmp_path / "f.sqlite")))
    yield d
    d.close()


def _ids(d, text):
    return [r["id"] for r in list_activities(d, ActivityFilter(text=text))["data"]["rows"]]


def test_split_type():
    assert split_type("WeightTraining") == "Weight Training"
    assert split_type("Run") == "Run"
    assert split_type("EBikeRide") == "EBike Ride"


def test_text_has_name_type_place_route_and_description(db):
    t = search_texts(db.conn)
    assert "slavnik out-and-back" in t["slavnik1"]          # route name
    assert "smarna gora" in t["smarna1"]
    assert "rain" in t["walk1"] and "weight training" in t["wt1"]
    assert "slavnik" not in t["run2"]                       # a deleted source's description is ignored
    assert "hidden1" in t                                   # hidden activities are in the table too
    assert t["grmada1"] == "polhograjska grmada\nhike\nhike\ngrmada"


def test_words_match_from_word_starts():
    assert words_match("weighttraining\nweight training", '["rain"]') == 0
    assert words_match("weather: 3°c, rain, cold", '["cold", "rain"]') == 1
    assert words_match("novo brdo loop", '["brdo"]') == 1 and words_match("novobrdo", '["brdo"]') == 0
    assert words_match("brdobrdo brdo", '["brdo"]') == 1   # a later hit at a word start counts
    assert words_match("weather: 3°c, rain", '["cold", "rain"]') == 0
    assert words_match("anything", "[]") == 1


def test_v4_database_without_group_tables(tmp_path):
    path = build_fixture_db(str(tmp_path / "v4.sqlite"))
    conn = sqlite3.connect(path)
    for table in ("places", "route_groups", "activity_groups"):
        conn.execute(f"DROP TABLE {table}")
    conn.commit()
    conn.close()
    d = Database(path)
    try:
        t = search_texts(d.conn)
        assert t["slavnik1"] == "slavnik\nhike\nhike"           # no place or route name
        assert "rain" in t["walk1"]
        assert _ids(d, "cold rain") == ["walk1"]
        assert _ids(d, "out-and-back") == []
    finally:
        d.close()


def test_bad_summary_json_is_skipped(tmp_path):
    path = build_fixture_db(str(tmp_path / "f.sqlite"))
    conn = sqlite3.connect(path)
    conn.executemany(
        "INSERT INTO activity_sources (provider, provider_activity_id, activity_id, summary_json) "
        "VALUES ('strava', ?, ?, ?)", [
            ("901", "run3", "not json"), ("902", "run3", "{}"), ("903", "run3", "[1, 2]"),
            ("904", "run3", '{"Activity Description": ""}'), ("905", "run3", '{"Activity Description": null}'),
        ])
    conn.commit()
    conn.close()
    d = Database(path)
    try:
        assert search_texts(d.conn)["run3"] == "run run3\nrun\nrun"
        assert _ids(d, "run3") == ["run3"]
    finally:
        d.close()


def test_reopen_rebuilds(tmp_path):
    path = build_fixture_db(str(tmp_path / "f.sqlite"))
    d = Database(path)
    try:
        assert _ids(d, "velika planina") == []
        other = str(tmp_path / "other.sqlite")
        shutil.copyfile(path, other)
        c = sqlite3.connect(other)
        c.execute("UPDATE activities SET name = 'Velika Planina' WHERE id = 'run2'")
        c.commit()
        c.close()
        writer.install(other, path)
        assert d.changed_on_disk()
        d.reopen()
        assert _ids(d, "velika planina") == ["run2"]
    finally:
        d.close()


def test_query_tool_cannot_read_the_text_table(db):
    with pytest.raises(QueryError):
        run_query(db, "SELECT * FROM temp.activity_text")
    with pytest.raises(QueryError):
        run_query(db, "SELECT * FROM activity_text")
    with pytest.raises(QueryError):
        run_query(db, "SELECT words_match('a', '[]')")
    with pytest.raises(QueryError):
        run_query(db, "SELECT fold(name) FROM activities")
