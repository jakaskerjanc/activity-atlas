import pytest

from ingest.mcp_server.database import Database, QueryError, run_query
from ingest.tests.mcp_fixture import build_fixture_db


@pytest.fixture
def db(tmp_path):
    d = Database(build_fixture_db(str(tmp_path / "f.sqlite")))
    yield d
    d.close()


def test_query_returns_rows(db):
    r = run_query(db, "select id from activities order by id")
    assert ["run1"] in r["data"]["rows"]
    assert r["data"]["columns"] == ["id"]


def test_query_caps_rows(db):
    r = run_query(db, "select id from activities", max_rows=2)
    assert len(r["data"]["rows"]) == 2 and r["data"]["truncated"]


def test_query_hard_cap(db):
    r = run_query(db, "select 1", max_rows=10**6)
    assert "max_rows capped at 2000" in r["counted"]["rules"]


def test_query_params(db):
    r = run_query(db, "select id from activities where type = ?", ["Hike"])
    assert r["data"]["rows"] == [["hike1"]]


def test_blocked_columns_read_as_null(db):
    assert run_query(db, "select raw from daily_stats where raw is not null")["data"]["rows"] == []
    assert run_query(db, "select summary_json, reported from activity_sources")["data"]["rows"] == [[None, None]]


@pytest.mark.parametrize("sql", [
    "delete from activities",
    "attach database ':memory:' as x",
    "pragma query_only=0",
    "create temp table t(x)",
    "insert into activities(id) values('z')",
])
def test_query_refuses_writes(db, sql):
    with pytest.raises(QueryError):
        run_query(db, sql)
    assert run_query(db, "select count(*) from activities")["data"]["rows"][0][0] == 7


@pytest.mark.parametrize("sql", ["select * from dbstat", "select * from sqlite_dbpage"])
def test_query_refuses_tables_outside_the_schema(db, sql):
    with pytest.raises(QueryError):
        run_query(db, sql)


def test_query_can_read_the_schema(db):
    r = run_query(db, "select name from sqlite_master where type = 'table' and name = 'activities'")
    assert r["data"]["rows"] == [["activities"]]


def test_query_time_limit(db, monkeypatch):
    monkeypatch.setattr("ingest.mcp_server.database.QUERY_TIME_LIMIT_S", 0.2)
    with pytest.raises(QueryError, match="time limit"):
        run_query(db, "with recursive c(x) as (select 1 union all select x+1 from c) select count(*) from c")
    assert run_query(db, "select 1")["data"]["rows"] == [[1]]


def test_internal_conn_reads_raw(db):
    assert db.conn.execute("select count(raw) from daily_stats").fetchone()[0] >= 1


def test_internal_conn_is_read_only(db):
    with pytest.raises(Exception):
        db.conn.execute("delete from activities")


def test_reopen_keeps_working(db):
    db.reopen()
    assert run_query(db, "select count(*) from activities")["data"]["rows"][0][0] == 7
