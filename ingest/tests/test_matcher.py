import re

import pytest

from ingest import matcher
from ingest.parse import ParsedFile
from ingest.tests.factories import NOW, fresh as _fresh, src as _src

ID_RE = re.compile(r"^[a-z0-9]{10}$")


def _ids(conn):
    return [r[0] for r in conn.execute("SELECT id FROM activities ORDER BY id")]


def _source(conn, provider, pid):
    return conn.execute("SELECT * FROM activity_sources WHERE provider=? AND provider_activity_id=?",
                        (provider, pid)).fetchone()


def _gps():
    return ParsedFile(streams={"time": [0.0, 10.0], "lat": [46.0, 46.01], "lon": [14.5, 14.5]})


def test_insert_assigns_random_neutral_id():
    conn = _fresh()
    assert matcher.reconcile(conn, _src("strava", "1", start="06:00", elapsed=3600), now=NOW) == "insert"
    assert ID_RE.match(conn.execute("SELECT id FROM activities").fetchone()[0])


def test_new_activity_id_is_unused():
    conn = _fresh()
    ids = {matcher.new_activity_id(conn) for _ in range(50)}
    assert len(ids) == 50 and all(ID_RE.match(i) for i in ids)


def test_same_record_again_updates_in_place():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1"), now=NOW)
    before = _ids(conn)
    assert matcher.reconcile(conn, _src("strava", "1", name="Renamed"), now=NOW) == "update"
    assert _ids(conn) == before
    assert conn.execute("SELECT name FROM activities").fetchone()[0] == "Renamed"


def test_crop_on_one_provider_still_merges():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", start="06:00", elapsed=3600), now=NOW)
    assert matcher.reconcile(conn, _src("garmin", "9", start="06:10", elapsed=2700), now=NOW) == "merge"
    assert len(_ids(conn)) == 1


def test_same_provider_records_never_merge():
    conn = _fresh()
    matcher.reconcile(conn, _src("garmin", "1", start="06:00", elapsed=3600), now=NOW)
    assert matcher.reconcile(conn, _src("garmin", "2", start="06:05", elapsed=3600), now=NOW) == "insert"
    assert len(_ids(conn)) == 2


def test_distance_guard_blocks_gps_mismatch():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", distance=10000.0, parsed=_gps(), file_sha256="a" * 64), now=NOW)
    g = _src("garmin", "9", distance=7000.0, parsed=_gps(), file_sha256="b" * 64)
    assert matcher.reconcile(conn, g, now=NOW) == "insert"


def test_distance_guard_ignores_sources_without_gps():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", distance=10000.0), now=NOW)
    assert matcher.reconcile(conn, _src("garmin", "9", distance=7000.0), now=NOW) == "merge"


def test_zero_or_missing_elapsed_uses_start_window():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", start="06:30:00", elapsed=None), now=NOW)
    assert matcher.reconcile(conn, _src("garmin", "9", start="06:32:00", elapsed=600), now=NOW) == "merge"
    assert matcher.reconcile(conn, _src("garmin", "8", start="06:34:00", elapsed=600), now=NOW) == "insert"
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", start="06:30:00", elapsed=0), now=NOW)
    assert matcher.reconcile(conn, _src("garmin", "9", start="06:30:00", elapsed=0), now=NOW) == "merge"


def test_deleted_slot_frees_for_reupload():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1"), now=NOW)
    matcher.reconcile(conn, _src("garmin", "9"), now=NOW)
    aid = _source(conn, "strava", "1")["activity_id"]
    conn.execute("UPDATE activity_sources SET deleted_at=? WHERE provider='strava' AND provider_activity_id='1'", (NOW,))
    assert matcher.reconcile(conn, _src("strava", "2"), now=NOW) == "merge"
    assert _source(conn, "strava", "2")["activity_id"] == aid


def test_old_record_does_not_undelete_but_newer_does():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1"), now=NOW)
    conn.execute("UPDATE activity_sources SET deleted_at='2026-10-20T00:00:00+00:00'")
    matcher.reconcile(conn, _src("strava", "1", fetched_at="2026-10-01T10:00:00+00:00"), now=NOW)
    assert _source(conn, "strava", "1")["deleted_at"] is not None
    matcher.reconcile(conn, _src("strava", "1", fetched_at="2026-10-25T10:00:00+00:00"), now=NOW)
    assert _source(conn, "strava", "1")["deleted_at"] is None


def test_type_mismatch_warns_but_merges():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", type="Run"), now=NOW)
    with pytest.warns(UserWarning):
        assert matcher.reconcile(conn, _src("garmin", "9", type="Walk"), now=NOW) == "merge"


def test_pinned_source_keeps_activity_on_update():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1"), now=NOW)
    conn.execute("UPDATE activity_sources SET pinned=1, activity_id='keepme0001'")
    assert matcher.reconcile(conn, _src("strava", "1"), now=NOW) == "update"
    assert _source(conn, "strava", "1")["activity_id"] == "keepme0001"
    assert "keepme0001" in _ids(conn)


def test_best_overlap_wins():
    conn = _fresh()
    matcher.reconcile(conn, _src("strava", "1", start="06:00", elapsed=3600), now=NOW)
    matcher.reconcile(conn, _src("strava", "2", start="07:00", elapsed=3600), now=NOW)
    second = _source(conn, "strava", "2")["activity_id"]
    assert matcher.reconcile(conn, _src("garmin", "9", start="06:40", elapsed=3600), now=NOW) == "merge"
    assert _source(conn, "garmin", "9")["activity_id"] == second
