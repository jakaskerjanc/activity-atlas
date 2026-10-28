import pytest
from ingest import db


def test_init_sets_version_and_tables():
    conn = db.connect(":memory:"); db.init_schema(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"activities", "activity_sources", "activity_overrides", "streams", "laps", "gear",
            "activity_gear", "daily_stats", "daily_series", "raw_files"} <= names


def test_activities_keeps_build_tracks_columns():
    conn = db.connect(":memory:"); db.init_schema(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(activities)")}
    assert {"id", "name", "type", "start_time", "distance", "moving_time", "elevation_gain", "polyline"} <= cols


def test_open_db_rejects_v1(tmp_path):
    p = tmp_path / "v1.sqlite"
    c = db.connect(str(p)); c.execute("CREATE TABLE activities (id TEXT PRIMARY KEY)"); c.commit(); c.close()
    with pytest.raises(db.SchemaMismatch):
        db.open_db(str(p))


def test_open_db_flags_older_v2(tmp_path):
    p = tmp_path / "old.sqlite"
    c = db.connect(str(p)); db.init_schema(c); c.execute("PRAGMA user_version = 1"); c.commit(); c.close()
    with pytest.raises(db.NeedsRebuild):
        db.open_db(str(p))


def test_open_db_initialises_new_file(tmp_path):
    conn = db.open_db(str(tmp_path / "new.sqlite"))
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
