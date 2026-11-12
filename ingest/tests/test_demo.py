import math

from ingest import db
from ingest.demo.build import build

ROUTES = {
    "v": 1,
    "routes": [
        {"key": "loop", "name": "Test loop", "kind": "Run",
         "points": [[46.557 + i * 0.001, 15.645 + (i % 3) * 0.0004, 300 + 8 * math.sin(i / 2)]
                    for i in range(14)]},
        {"key": "spin", "name": "Test spin", "kind": "Ride",
         "points": [[46.520 + i * 0.001, 15.600 + (i % 4) * 0.0005, 280 + 12 * math.cos(i / 2)]
                    for i in range(14)]},
        {"key": "hill", "name": "Test hill", "kind": "Hike",
         "points": [[46.500 + i * 0.001, 15.560 + (i % 2) * 0.0006, 400 + i * 6]
                    for i in range(14)]},
        {"key": "park", "name": "Test park", "kind": "Walk",
         "points": [[46.560 + i * 0.0007, 15.640 + (i % 2) * 0.0005, 290 + 2 * math.sin(i)]
                    for i in range(14)]},
    ],
}
COUNTS = {"Run": 2, "Ride": 1, "Hike": 1, "Walk": 1, "WeightTraining": 1}


def _build(tmp_path, name):
    out = tmp_path / f"{name}.sqlite"
    stats = build(ROUTES, str(out), str(tmp_path / name), seed=7, counts=COUNTS)
    return stats, out


def test_demo_build_is_a_complete_deterministic_database(tmp_path):
    stats, out = _build(tmp_path, "one")
    assert stats["activities"] == 6
    assert stats["with_gps"] == 5
    assert stats["with_hr"] == 5

    conn = db.connect(str(out))
    try:
        rows = conn.execute(
            "SELECT id, type, visible, has_gps, polyline FROM activities ORDER BY start_time").fetchall()
        assert [r["id"] for r in rows] == [f"demo{i:06d}" for i in range(1, 7)]
        assert {r["type"] for r in rows} == {"Run", "Ride", "Hike", "Walk", "WeightTraining"}
        assert all(r["visible"] == 1 for r in rows)
        assert sum(1 for r in rows if r["has_gps"]) == 5
        assert all((r["polyline"] != "") == bool(r["has_gps"]) for r in rows)
        assert conn.execute("SELECT COUNT(*) FROM streams").fetchone()[0] == 5
        assert conn.execute("SELECT COUNT(*) FROM activity_sources").fetchone()[0] == 6
        assert conn.execute("SELECT COUNT(*) FROM activity_sources WHERE provider='strava'").fetchone()[0] == 6
        assert conn.execute("SELECT COUNT(*) FROM gear WHERE name LIKE 'Demo%'").fetchone()[0] >= 2
        runs = [r[0] for r in conn.execute("SELECT id FROM activities WHERE type='Run' ORDER BY start_time")]
        assert [tuple(r) for r in conn.execute("SELECT activity_id, route_id FROM activity_groups "
                                               "WHERE route_id IS NOT NULL ORDER BY activity_id")] == [
            (runs[0], runs[0]), (runs[1], runs[0])]
    finally:
        conn.close()

    stats2, out2 = _build(tmp_path, "two")
    assert stats2["activities"] == stats["activities"]
    conn, conn2 = db.connect(str(out)), db.connect(str(out2))
    try:
        rows = conn.execute("SELECT * FROM activities ORDER BY id").fetchall()
        rows2 = conn2.execute("SELECT * FROM activities ORDER BY id").fetchall()
        assert [dict(r) for r in rows] == [dict(r) for r in rows2]
    finally:
        conn.close()
        conn2.close()
