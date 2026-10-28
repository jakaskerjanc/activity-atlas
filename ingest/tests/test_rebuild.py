import gzip
import warnings

import pytest

from ingest import db, engine, merge
from ingest.archive import LocalArchive
from ingest.garmin_import import GarminImporter
from ingest.rebuild import rebuild
from ingest.strava_import import StravaImporter
from ingest.tests.factories import fixture_bytes
from ingest.tests.test_garmin_import import _garmin_zip
from ingest.tests.test_strava_import import GYM, HEADER, _row, _zip

NOW = "2026-10-27T10:00:00+00:00"


def _imported(tmp_path):
    """Strava (walk + gym) then Garmin (run merging with the walk + its own gym)."""
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    walk = _row(111, "Feb 18, 2026, 4:06:36 PM", "Morning Walk", "Walk", "activities/outdoor.fit.gz")
    StravaImporter(_zip(tmp_path, HEADER + walk + GYM,
                        {"activities/outdoor.fit.gz": gzip.compress(fixture_bytes("outdoor.fit"))}),
                   dbp, arch, now=NOW).run()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        GarminImporter(_garmin_zip(tmp_path, run_distance_cm=466285), dbp, arch, now=NOW).run()
    return dbp, arch


def _snapshot(dbp, table="activities", order="id"):
    conn = db.connect(dbp)
    try:
        return [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY {order}")]
    finally:
        conn.close()


def _identity(dbp):
    conn = db.connect(dbp)
    try:
        return [tuple(r) for r in conn.execute(
            "SELECT provider, provider_activity_id, activity_id, pinned, deleted_at FROM activity_sources "
            "ORDER BY provider, provider_activity_id")]
    finally:
        conn.close()


def test_rebuild_is_deterministic_and_keeps_ids(tmp_path):
    dbp, arch = _imported(tmp_path)
    before, ident = _snapshot(dbp), _identity(dbp)
    assert len(before) == 3                                    # merged pair + one gym on each side
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        counts = rebuild(dbp, arch, now="2026-10-28T10:00:00+00:00")
    assert counts == {"insert": 0, "update": 4, "merge": 0}
    assert _snapshot(dbp) == before and _identity(dbp) == ident
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rebuild(dbp, arch, now="2026-10-29T10:00:00+00:00")
    assert _snapshot(dbp) == before
    assert _snapshot(dbp, "streams", "file_sha256") and _snapshot(dbp, "laps", "file_sha256, lap_index")


def test_rebuild_keeps_pinned_split_deleted_and_hidden(tmp_path):
    dbp, arch = _imported(tmp_path)
    conn = db.connect(dbp)
    old = conn.execute("SELECT activity_id FROM activity_sources WHERE provider='garmin' "
                       "AND provider_activity_id='900001'").fetchone()[0]
    conn.execute("UPDATE activity_sources SET activity_id='splitgarm1', pinned=1 "
                 "WHERE provider='garmin' AND provider_activity_id='900001'")
    conn.execute("UPDATE activity_sources SET pinned=1 WHERE provider='strava' AND provider_activity_id='111'")
    conn.execute("UPDATE activity_sources SET deleted_at=? WHERE provider='strava' AND provider_activity_id='222'", (NOW,))
    gym = conn.execute("SELECT activity_id FROM activity_sources WHERE provider='garmin' "
                       "AND provider_activity_id='900002'").fetchone()[0]
    conn.execute("INSERT INTO activity_overrides (activity_id, hidden) VALUES (?, 1)", (gym,))
    strava_gym = conn.execute("SELECT activity_id FROM activity_sources WHERE provider='strava' "
                              "AND provider_activity_id='222'").fetchone()[0]
    for aid in (old, "splitgarm1", gym, strava_gym):
        merge.recompute_activity(conn, aid)
    conn.commit(); conn.close()
    before, ident = _snapshot(dbp), _identity(dbp)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rebuild(dbp, arch, now="2026-10-28T10:00:00+00:00")
    assert _identity(dbp) == ident and _snapshot(dbp) == before
    assert _snapshot(dbp, "activity_overrides", "activity_id") == [(gym, 1)]
    conn = db.connect(dbp)
    vis = dict(conn.execute("SELECT id, visible FROM activities"))
    assert vis[gym] == 0 and vis[strava_gym] == 0 and vis["splitgarm1"] == 1 and vis[old] == 1


def test_writer_rebuilds_older_v2_and_refuses_v1(tmp_path, capsys):
    dbp, arch = _imported(tmp_path)
    ident = _identity(dbp)
    conn = db.connect(dbp); conn.execute("PRAGMA user_version = 1"); conn.commit(); conn.close()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        conn = engine.open_for_write(dbp, arch, now=NOW)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    conn.close()
    assert _identity(dbp) == ident

    v1 = tmp_path / "v1.sqlite"
    c = db.connect(str(v1)); c.execute("CREATE TABLE activities (id TEXT PRIMARY KEY)"); c.commit(); c.close()
    with pytest.raises(SystemExit) as exc:
        engine.open_for_write(str(v1), arch, now=NOW)
    assert exc.value.code == 4
    assert "v1 database at" in capsys.readouterr().err


def test_rebuild_without_existing_db_assigns_new_ids(tmp_path):
    dbp, arch = _imported(tmp_path)
    fresh = str(tmp_path / "fresh.sqlite")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        counts = rebuild(fresh, arch, now=NOW)
    assert counts == {"insert": 3, "update": 0, "merge": 1}
    assert len(_snapshot(fresh)) == 3


def test_rebuild_refuses_to_drop_activities_missing_from_archive(tmp_path):
    dbp, arch = _imported(tmp_path)
    before = _snapshot(dbp)
    with pytest.raises(SystemExit) as exc:
        rebuild(dbp, LocalArchive(str(tmp_path / "typo")), now=NOW)
    assert "no record in the archive" in str(exc.value)
    assert _snapshot(dbp) == before
    assert not (tmp_path / "db.sqlite.rebuild").exists()

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rebuild(dbp, LocalArchive(str(tmp_path / "typo")), now=NOW, force=True)
    assert _snapshot(dbp) == []
