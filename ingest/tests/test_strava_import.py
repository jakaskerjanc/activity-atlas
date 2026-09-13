import os
import shutil
from datetime import timezone

from ingest.strava_import import StravaImporter, _parse_date
from ingest import store

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _make_root(tmp_path, csv_text):
    root = tmp_path / "strava"
    (root / "activities").mkdir(parents=True)
    shutil.copy(os.path.join(FIX, "sample.gpx"), root / "activities" / "111.gpx")
    (root / "activities.csv").write_text(csv_text, encoding="utf-8")
    return str(root)


def test_parse_date_am_pm_is_utc():
    assert _parse_date("Aug 1, 2026, 6:30:00 AM").tzinfo == timezone.utc


def test_stats_from_csv_geometry_from_file(tmp_path):
    csv_text = (
        "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time,Elevation Gain,Filename\n"
        '111,"Aug 1, 2026, 6:30:00 AM",Morning Run,Run,3700,10250.5,3600,120.0,activities/111.gpx\n'
        '222,"Aug 2, 2026, 5:00:00 PM",Strength,Weight Training,2400,0,2400,0,\n'
    )
    db = str(tmp_path / "db.sqlite")
    assert StravaImporter(_make_root(tmp_path, csv_text), db).run()["insert"] == 2
    conn = store.connect(db)
    run = store.find_by_service_id(conn, "strava", "111")
    assert run.type == "Run" and run.distance == 10250.5 and run.moving_time == 3600
    assert run.polyline != ""
    gym = store.find_by_service_id(conn, "strava", "222")
    assert gym.type == "WeightTraining" and gym.polyline == ""


def test_duplicate_distance_columns_last_wins(tmp_path):
    # Real Strava exports repeat Distance; DictReader keeps the last = meters.
    csv_text = (
        "Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time,Elevation Gain,Distance,Filename\n"
        '111,"Aug 1, 2026, 6:30:00 AM",Run,Run,10.25,3600,120.0,10250.5,\n'
    )
    db = str(tmp_path / "db.sqlite")
    StravaImporter(_make_root(tmp_path, csv_text), db).run()
    conn = store.connect(db)
    assert store.find_by_service_id(conn, "strava", "111").distance == 10250.5
