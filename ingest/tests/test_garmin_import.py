import json
import os
import shutil

from ingest.garmin_import import GarminImporter, _iter_summaries
from ingest.parse.fit import parse_fit
from ingest import store

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _outdoor_start_ms():
    with open(os.path.join(FIX, "outdoor.fit"), "rb") as f:
        return int(parse_fit(f).start_time.timestamp() * 1000)


def _make_root(tmp_path):
    root = tmp_path / "garmin"
    fitdir = root / "DI_CONNECT" / "DI-Connect-Fitness"
    updir = root / "DI_CONNECT" / "DI-Connect-Uploaded-Files"
    fitdir.mkdir(parents=True)
    updir.mkdir(parents=True)
    shutil.copy(os.path.join(FIX, "garmin_uploaded.zip"), updir / "UploadedFiles_0-_Part1.zip")
    summaries = [[
        {"activityId": 900001, "name": "Match Run", "activityType": "running",
         "startTimeGmt": _outdoor_start_ms(), "distance": 1025050, "duration": 3700000,
         "movingDuration": 3600000, "elevationGain": 12000},
        {"activityId": 900002, "name": "Gym", "activityType": "strength_training",
         "startTimeGmt": 1785998400000, "distance": 0, "duration": 2400000,
         "movingDuration": None, "elevationGain": None},
    ]]
    (fitdir / "u_1_summarizedActivities.json").write_text(json.dumps(summaries))
    return str(root)


def test_iter_summaries_flattens_nested():
    got = [s["activityId"] for s in _iter_summaries([[{"activityId": 1}], {"activityId": 2}])]
    assert got == [1, 2]


def test_matches_fit_geometry_and_scales_units(tmp_path):
    db = str(tmp_path / "db.sqlite")
    assert GarminImporter(_make_root(tmp_path), db).run()["insert"] == 2
    conn = store.connect(db)
    run = store.find_by_service_id(conn, "garmin", "900001")
    assert run.type == "Run"
    assert run.distance == 10250.5 and run.elevation_gain == 120.0 and run.moving_time == 3600
    assert run.polyline != ""            # matched outdoor.fit
    gym = store.find_by_service_id(conn, "garmin", "900002")
    assert gym.polyline == ""            # no time-matched FIT
    assert gym.moving_time == 2400 and gym.distance == 0.0 and gym.elevation_gain == 0.0
