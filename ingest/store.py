import sqlite3
from datetime import datetime, timedelta
from .model import Activity

SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  strava_id TEXT,
  garmin_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  start_time TEXT NOT NULL,
  distance REAL NOT NULL,
  moving_time INTEGER NOT NULL,
  elevation_gain REAL NOT NULL,
  polyline TEXT NOT NULL,
  start_lat REAL,
  start_lng REAL
);
CREATE INDEX IF NOT EXISTS idx_strava ON activities(strava_id);
CREATE INDEX IF NOT EXISTS idx_garmin ON activities(garmin_id);
CREATE INDEX IF NOT EXISTS idx_start  ON activities(start_time);
"""

_COLS = ("id", "strava_id", "garmin_id", "name", "type", "start_time", "distance",
         "moving_time", "elevation_gain", "polyline", "start_lat", "start_lng")


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn):
    conn.executescript(SCHEMA)


def _row(r):
    return Activity(**{c: r[c] for c in _COLS})


def find_by_service_id(conn, service, sid):
    col = "strava_id" if service == "strava" else "garmin_id"
    r = conn.execute(f"SELECT * FROM activities WHERE {col}=?", (sid,)).fetchone()
    return _row(r) if r else None


def find_near(conn, start_iso, window_s):
    t = datetime.fromisoformat(start_iso)
    lo = (t - timedelta(seconds=window_s)).isoformat()
    hi = (t + timedelta(seconds=window_s)).isoformat()
    rows = conn.execute(
        "SELECT * FROM activities WHERE start_time BETWEEN ? AND ?", (lo, hi)
    ).fetchall()
    return [_row(r) for r in rows]


def upsert(conn, a: Activity):
    conn.execute(
        f"INSERT INTO activities ({','.join(_COLS)}) VALUES ({','.join('?' * len(_COLS))}) "
        "ON CONFLICT(id) DO UPDATE SET " +
        ", ".join(f"{c}=excluded.{c}" for c in _COLS if c != "id"),
        tuple(getattr(a, c) for c in _COLS),
    )


def all_activities(conn):
    return [_row(r) for r in conn.execute("SELECT * FROM activities").fetchall()]
