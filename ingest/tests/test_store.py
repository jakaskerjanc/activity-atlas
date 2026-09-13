from ingest import store
from ingest.model import Activity


def _act(**kw):
    base = dict(id="s:1", strava_id="1", garmin_id=None, name="n", type="Run",
                start_time="2026-08-01T06:30:00+00:00", distance=1.0, moving_time=100,
                elevation_gain=0.0, polyline="abc", start_lat=46.0, start_lng=14.0)
    base.update(kw)
    return Activity(**base)


def test_upsert_and_find_by_id():
    conn = store.connect(":memory:"); store.init_schema(conn)
    store.upsert(conn, _act())
    got = store.find_by_service_id(conn, "strava", "1")
    assert got is not None and got.id == "s:1" and got.polyline == "abc"
    assert store.find_by_service_id(conn, "garmin", "1") is None


def test_upsert_updates_in_place():
    conn = store.connect(":memory:"); store.init_schema(conn)
    store.upsert(conn, _act(name="old"))
    store.upsert(conn, _act(name="new", garmin_id="9"))
    got = store.find_by_service_id(conn, "strava", "1")
    assert got.name == "new" and got.garmin_id == "9"
    assert len(store.all_activities(conn)) == 1


def test_find_near_respects_window():
    conn = store.connect(":memory:"); store.init_schema(conn)
    store.upsert(conn, _act(id="s:1", strava_id="1", start_time="2026-08-01T06:30:00+00:00"))
    near = store.find_near(conn, "2026-08-01T06:31:00+00:00", 90)   # 60s away
    far = store.find_near(conn, "2026-08-01T06:40:00+00:00", 90)    # 600s away
    assert len(near) == 1 and far == []
