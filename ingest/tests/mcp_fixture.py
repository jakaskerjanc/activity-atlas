"""A small database for the MCP server tests (see the plan's Task 1 for its contents)."""
import json
from datetime import datetime, timedelta

import polyline

from ingest import codec, db

OFFSET = 3600  # UTC+1


def _times(start_utc: str, offset: int = OFFSET) -> tuple[str, str]:
    t = datetime.fromisoformat(start_utc)
    local = (t + timedelta(seconds=offset)).replace(tzinfo=None)
    return t.isoformat(), local.isoformat()


def _insert_activity(conn, id_, type_, start_utc, *, name=None, distance=None, moving=None, elapsed=None,
                     avg_hr=None, gain=None, visible=1, track=None, offset=OFFSET):
    start_time, start_local = _times(start_utc, offset)
    row = {
        "id": id_, "name": name or f"{type_} {id_}", "type": type_, "start_time": start_time,
        "start_local": start_local, "utc_offset_s": offset, "distance": distance, "moving_time": moving,
        "elapsed_time": elapsed, "avg_hr": avg_hr, "elevation_gain": gain, "visible": visible,
        "has_hr": int(avg_hr is not None),
    }
    if track:
        sha = f"sha-{id_}"
        lats, lons = track["lat"], track["lon"]
        pts = [(a, b) for a, b in zip(lats, lons) if a is not None]
        row.update({
            "streams_sha256": sha, "has_gps": 1, "polyline": polyline.encode(pts, 5),
            "start_lat": pts[0][0], "start_lng": pts[0][1],
            "min_lat": min(p[0] for p in pts), "max_lat": max(p[0] for p in pts),
            "min_lng": min(p[1] for p in pts), "max_lng": max(p[1] for p in pts),
        })
        channels = {k: codec.encode(k, v) for k, v in track.items()}
        cols = ", ".join(channels)
        conn.execute(
            f"INSERT INTO streams (file_sha256, sample_count, encoding, {cols}) VALUES (?, ?, 1, "
            + ", ".join("?" * len(channels)) + ")",
            (sha, len(track["time"]), *channels.values()),
        )
    cols = ", ".join(row)
    conn.execute(f"INSERT INTO activities ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


def build_fixture_db(path: str) -> str:
    conn = db.open_db(path)
    run1_track = {
        "time": [i * 300.0 for i in range(10)],
        "lat": [46.0 + i * 0.01 for i in range(10)],
        "lon": [14.0] * 10,
        "hr": [140.0 + i * 2 for i in range(10)],
        "distance": [i * 1111.0 for i in range(10)],
        "altitude": [300.0 + i for i in range(10)],
    }
    _insert_activity(conn, "run1", "Run", "2025-03-10T07:00:00+00:00", distance=10000, moving=3000,
                     elapsed=3100, avg_hr=150, gain=50, track=run1_track)
    _insert_activity(conn, "run2", "Run", "2025-03-12T07:00:00+00:00", distance=5000, moving=1500)
    _insert_activity(conn, "run3", "Run", "2025-12-31T23:30:00+00:00", distance=8000, moving=2400, avg_hr=140)
    _insert_activity(conn, "run_nomove", "Run", "2025-03-14T07:00:00+00:00", distance=3000)
    _insert_activity(conn, "hidden1", "Run", "2025-03-15T07:00:00+00:00", distance=4000, moving=1200, visible=0)
    _insert_activity(conn, "walk1", "Walk", "2025-03-11T07:00:00+00:00", moving=600)
    # Passes 11 m north of the Triglav summit (46.3783, 13.8369); sample 3 lost GPS.
    lons = [13.830, 13.832, 13.834, 13.835, 13.8369, 13.839, 13.841, 13.843, 13.845, 13.847]
    hike_track = {
        "time": [i * 1800.0 for i in range(10)],
        "lat": [46.3784] * 10,
        "lon": lons,
        "altitude": [2000.0 + i * 50 for i in range(10)],
    }
    hike_track["lat"][3] = None
    hike_track["lon"][3] = None
    _insert_activity(conn, "hike1", "Hike", "2024-09-10T00:12:00+00:00", name="Triglav Sunrise",
                     distance=12000, moving=18000, gain=1500, track=hike_track, offset=7200)

    conn.execute(
        "INSERT INTO activity_sources (provider, provider_activity_id, activity_id, url, summary_json, reported) "
        "VALUES ('strava', '111', 'run1', 'https://www.strava.com/activities/111', ?, ?)",
        (json.dumps({"description": "private"}), json.dumps({"x": 1})),
    )
    conn.execute("INSERT INTO laps (file_sha256, lap_index, distance_m, elapsed_s) VALUES ('sha-run1', 0, 5000, 1500)")
    conn.execute("INSERT INTO laps (file_sha256, lap_index, distance_m, elapsed_s) VALUES ('sha-run1', 1, 5000, 1500)")
    conn.execute("INSERT INTO gear (provider, name, kind) VALUES ('strava', 'Shoe A', 'shoes')")
    conn.execute("INSERT INTO activity_gear (activity_id, provider, gear_name) VALUES ('run1', 'strava', 'Shoe A')")

    for i in range(7):
        day = f"2025-03-{10 + i:02d}"
        conn.execute(
            "INSERT INTO daily_stats (date, resting_hr, sleep_s, hrv_avg, raw) VALUES (?, ?, ?, ?, ?)",
            (day, 50 + i, 25200 + i * 600, None if i == 2 else 40 + i,
             json.dumps({"secret": 1}) if i == 0 else None),
        )
    times = [i * 120.0 for i in range(720)]
    conn.execute(
        "INSERT INTO daily_series (date, channel, sample_count, encoding, utc_offset_s, time, data) "
        "VALUES ('2025-03-10', 'hr', 720, 1, 3600, ?, ?)",
        (codec.encode("time", times), codec.encode("hr", [60.0 + i % 40 for i in range(720)])),
    )
    conn.commit()
    conn.close()
    return path

