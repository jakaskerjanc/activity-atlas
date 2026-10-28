import json

from ingest import merge
from ingest.parse import ParsedFile
from ingest.tests.factories import NOW, at, fresh as _fresh, outdoor as _outdoor, src as _src


def _act(conn, aid="a1"):
    return conn.execute("SELECT * FROM activities WHERE id=?", (aid,)).fetchone()


def test_strava_wins_and_garmin_fills_gaps():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1", name="Strava name", reported={"elevation_gain_m": 120.0}), "a1", now=NOW)
    merge.write_source(conn, _src("garmin", "9", name="Garmin name", reported={"elevation_gain_m": 131.0, "calories": 330.0}), "a1", now=NOW)
    merge.recompute_activity(conn, "a1")
    r = _act(conn)
    assert (r["name"], r["elevation_gain"], r["calories"]) == ("Strava name", 120.0, 330.0)
    assert json.loads(r["calculated"]) == []
    assert r["meta_provider"] == "strava"


def test_manual_strava_entry_takes_garmin_streams():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1", parsed=None, file_sha256=None), "a1", now=NOW)
    g = _src("garmin", "9", parsed=_outdoor(), file_sha256="f" * 64)
    merge.write_file_data(conn, g.file_sha256, g.parsed); merge.write_source(conn, g, "a1", now=NOW)
    merge.recompute_activity(conn, "a1")
    r = _act(conn)
    assert r["streams_sha256"] == "f" * 64 and r["has_hr"] == 1 and r["has_gps"] == 1 and r["polyline"] != ""


def test_calculated_avg_hr_is_flagged():
    conn = _fresh()
    g = _src("garmin", "9", parsed=_outdoor(), file_sha256="f" * 64)
    merge.write_file_data(conn, g.file_sha256, g.parsed); merge.write_source(conn, g, "a1", now=NOW)
    merge.recompute_activity(conn, "a1")
    r = _act(conn)
    assert abs(r["avg_hr"] - 97.41) < 0.01         # time-weighted (plain mean would be 97.34)
    assert "avg_hr" in json.loads(r["calculated"])
    assert r["calories"] is None and r["aerobic_te"] is None       # never calculated


def test_deleted_strava_falls_back_to_garmin_and_all_deleted_hides():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1", name="Strava name"), "a1", now=NOW)
    merge.write_source(conn, _src("garmin", "9", name="Garmin name"), "a1", now=NOW)
    conn.execute("UPDATE activity_sources SET deleted_at=? WHERE provider='strava'", (NOW,))
    merge.recompute_activity(conn, "a1")
    r = _act(conn)
    assert r["name"] == "Garmin name" and r["visible"] == 1
    conn.execute("UPDATE activity_sources SET deleted_at=? WHERE provider='garmin'", (NOW,))
    merge.recompute_activity(conn, "a1")
    r = _act(conn)
    assert r["visible"] == 0 and r["name"] == "Strava name"


def test_zone_limits_come_from_closest_garmin_source():
    conn = _fresh()
    limits_a, limits_b = [100, 120, 140, 160, 180, 200], [97, 116, 136, 155, 175, 194]
    merge.write_source(conn, _src("garmin", "A", start_time=at("06:00", "2025-01-01"),
                                  hr_zones={"seconds": [1.0] * 7, "limits": limits_a}), "ga", now=NOW)
    merge.write_source(conn, _src("garmin", "B", start_time=at("06:00", "2026-02-01"),
                                  hr_zones={"seconds": [1.0] * 7, "limits": limits_b}), "gb", now=NOW)
    tcx = ParsedFile(start_time=at("06:00", "2026-02-18"),
                     streams={"time": [0.0, 10.0, 20.0], "hr": [90.0, 120.0, 150.0]})
    s = _src("strava", "1", start_time=at("06:00", "2026-02-18"), elapsed=20, parsed=tcx, file_sha256="t" * 64)
    merge.write_file_data(conn, s.file_sha256, s.parsed); merge.write_source(conn, s, "st", now=NOW)
    merge.recompute_activity(conn, "st")
    r = _act(conn, "st")
    assert json.loads(r["hr_zone_limits"]) == limits_b
    assert json.loads(r["hr_zone_seconds"]) == [10.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0]
    assert "hr_zone_seconds" in json.loads(r["calculated"])


def test_hidden_override_sets_visible_0():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1"), "a1", now=NOW)
    conn.execute("INSERT INTO activity_overrides (activity_id, hidden) VALUES ('a1', 1)")
    merge.recompute_activity(conn, "a1")
    assert _act(conn)["visible"] == 0


def test_source_urls():
    assert merge.source_url("strava", "123") == "https://www.strava.com/activities/123"
    assert merge.source_url("garmin", "123") == "https://connect.garmin.com/modern/activity/123"


def test_file_data_fills_missing_distance_from_positions():
    conn = _fresh()
    p = ParsedFile(streams={"time": [0.0, 5.0], "lat": [46.0, 46.001], "lon": [14.5, 14.5]})
    merge.write_file_data(conn, "d" * 64, p)
    row = conn.execute("SELECT * FROM streams WHERE file_sha256=?", ("d" * 64,)).fetchone()
    assert row["distance_calculated"] == 1 and row["distance"] is not None and row["sample_count"] == 2


def test_end_time_local_start_and_gear():
    conn = _fresh()
    merge.write_source(conn, _src("strava", "1", elapsed=600, utc_offset_s=7200, gear=["Pegasus"]), "a1", now=NOW)
    merge.recompute_activity(conn, "a1")
    r = _act(conn)
    assert r["end_time"] == "2026-08-01T06:10:00+00:00" and r["start_local"] == "2026-08-01T08:00:00"
    assert [tuple(g) for g in conn.execute("SELECT provider, gear_name FROM activity_gear WHERE activity_id='a1'")] == [("strava", "Pegasus")]
