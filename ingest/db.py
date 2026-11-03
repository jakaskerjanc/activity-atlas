"""The v2 SQLite schema. Everything is derived from the archive except the
identity columns of activity_sources (provider, provider_activity_id,
activity_id, pinned, deleted_at) and activity_overrides, which a rebuild
carries over.

Streams and laps are keyed by activity-file hash, so the identical FIT that
Strava and Garmin both hold is stored once and switching an activity's winner
needs no archive access.
"""
import os
import sqlite3

from .codec import CHANNEL_SCALES

SCHEMA_VERSION = 3


class SchemaMismatch(Exception):
    """The file is a v1 database (or from newer code); it cannot be opened."""


class NeedsRebuild(Exception):
    """The file is an older v2 schema; rebuild it from the archive."""


_STREAM_COLS = ",\n  ".join(f"{ch} BLOB" for ch in CHANNEL_SCALES)

SCHEMA = f"""
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  start_time TEXT,
  end_time TEXT,
  utc_offset_s INTEGER,
  start_local TEXT,
  elapsed_time REAL,
  moving_time REAL,
  distance REAL,
  elevation_gain REAL,
  elevation_loss REAL,
  avg_hr REAL,
  max_hr REAL,
  avg_cadence REAL,
  max_cadence REAL,
  avg_power REAL,
  max_power REAL,
  calories REAL,
  aerobic_te REAL,
  anaerobic_te REAL,
  hr_zone_seconds TEXT,
  hr_zone_limits TEXT,
  polyline TEXT NOT NULL DEFAULT '',
  start_lat REAL,
  start_lng REAL,
  min_lat REAL,
  min_lng REAL,
  max_lat REAL,
  max_lng REAL,
  has_gps INTEGER NOT NULL DEFAULT 0,
  has_hr INTEGER NOT NULL DEFAULT 0,
  has_altitude INTEGER NOT NULL DEFAULT 0,
  has_cadence INTEGER NOT NULL DEFAULT 0,
  has_power INTEGER NOT NULL DEFAULT 0,
  meta_provider TEXT,
  streams_sha256 TEXT,
  calculated TEXT NOT NULL DEFAULT '[]',
  visible INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_activities_start ON activities(start_time);
CREATE INDEX idx_activities_end ON activities(end_time);

CREATE TABLE activity_sources (
  provider TEXT NOT NULL,
  provider_activity_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  url TEXT,
  name TEXT,
  type TEXT,
  start_time TEXT,
  end_time TEXT,
  elapsed_time REAL,
  moving_time REAL,
  distance REAL,
  utc_offset_s INTEGER,
  reported TEXT,
  hr_zones TEXT,
  file_sha256 TEXT,
  gear TEXT,
  summary_json TEXT,
  fetched_at TEXT,
  first_seen TEXT,
  updated_at TEXT,
  PRIMARY KEY (provider, provider_activity_id)
);
CREATE INDEX idx_sources_activity ON activity_sources(activity_id);

CREATE TABLE activity_overrides (
  activity_id TEXT PRIMARY KEY,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE streams (
  file_sha256 TEXT PRIMARY KEY,
  sample_count INTEGER NOT NULL,
  encoding INTEGER NOT NULL,
  distance_calculated INTEGER NOT NULL DEFAULT 0,
  {_STREAM_COLS}
);

CREATE TABLE laps (
  file_sha256 TEXT NOT NULL,
  lap_index INTEGER NOT NULL,
  start_time TEXT,
  elapsed_s REAL,
  moving_s REAL,
  distance_m REAL,
  avg_hr REAL,
  max_hr REAL,
  avg_speed REAL,
  elevation_gain_m REAL,
  elevation_loss_m REAL,
  avg_cadence REAL,
  avg_power REAL,
  trigger TEXT,
  PRIMARY KEY (file_sha256, lap_index)
);

CREATE TABLE gear (
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  PRIMARY KEY (provider, name)
);

CREATE TABLE activity_gear (
  activity_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  gear_name TEXT NOT NULL,
  PRIMARY KEY (activity_id, provider, gear_name)
);

CREATE TABLE daily_stats (
  date TEXT PRIMARY KEY,
  resting_hr REAL,
  hrv_avg REAL,
  hrv_status TEXT,
  sleep_s REAL,
  sleep_score REAL,
  steps INTEGER,
  stress_avg REAL,
  body_battery_high REAL,
  body_battery_low REAL,
  weight_kg REAL,
  spo2_avg REAL,
  raw TEXT
);

CREATE TABLE daily_series (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  encoding INTEGER NOT NULL,
  utc_offset_s INTEGER,
  time BLOB,
  data BLOB,
  PRIMARY KEY (date, channel)
);

CREATE TABLE wellness_inputs (
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  date TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL,
  file_name TEXT,
  PRIMARY KEY (provider, source, key, date)
);
CREATE INDEX idx_wellness_inputs_date ON wellness_inputs(date);

CREATE TABLE raw_files (
  sha256 TEXT PRIMARY KEY,
  kind TEXT,
  provider TEXT,
  provider_ref TEXT,
  original_name TEXT,
  size INTEGER,
  fetched_at TEXT
);
"""


def connect(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema(conn) -> None:
    conn.executescript(SCHEMA)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    conn.commit()


def _has_tables(conn) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone() is not None


def open_db(path) -> sqlite3.Connection:
    """Open a current database, initializing an empty or missing file.
    Raises SchemaMismatch for a v1 (or newer) file, NeedsRebuild for an
    older v2 one."""
    if path != ":memory:" and os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = connect(path)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version == SCHEMA_VERSION:
        return conn
    if version == 0 and not _has_tables(conn):
        init_schema(conn)
        return conn
    conn.close()
    if 0 < version < SCHEMA_VERSION:
        raise NeedsRebuild(f"{path}: schema v{version} < v{SCHEMA_VERSION}")
    raise SchemaMismatch(f"{path}: not a v{SCHEMA_VERSION} database (user_version {version})")
