import argparse
import glob
import io
import json
import os
import zipfile
from datetime import datetime, timezone

from .base import BaseImporter
from .model import RawActivity
from .parse.fit import parse_fit


def _iter_summaries(obj):
    """Yield every dict with an activityId, however the JSON is nested."""
    if isinstance(obj, list):
        for x in obj:
            yield from _iter_summaries(x)
    elif isinstance(obj, dict):
        if "activityId" in obj:
            yield obj
        else:
            for v in obj.values():
                yield from _iter_summaries(v)


class GarminImporter(BaseImporter):
    source = "garmin"

    def __init__(self, export_root, db_path, match_window_s=90, **kw):
        super().__init__(db_path, **kw)
        self.root = export_root
        self.window = match_window_s

    def _summaries(self):
        out = []
        for path in glob.glob(os.path.join(self.root, "**", "*summarizedActivities.json"), recursive=True):
            with open(path, encoding="utf-8") as f:
                out.extend(_iter_summaries(json.load(f)))
        return out

    def _fit_index(self):
        """[(epoch_start, track)] for every activity-type FIT in UploadedFiles."""
        index = []
        for zpath in glob.glob(os.path.join(self.root, "**", "UploadedFiles_*.zip"), recursive=True):
            with zipfile.ZipFile(zpath) as zf:
                for name in zf.namelist():
                    if not name.lower().endswith(".fit"):
                        continue
                    raw = zf.read(name)
                    if parse_fit(io.BytesIO(raw), geometry=False).file_type != "activity":
                        continue
                    p = parse_fit(io.BytesIO(raw))
                    if p.start_time is not None:
                        index.append((p.start_time.timestamp(), p.track))
        return index

    def _track_for(self, start_epoch, index):
        for epoch, track in index:
            if abs(epoch - start_epoch) <= self.window:
                return track
        return []

    def activities(self):
        index = self._fit_index()
        for s in self._summaries():
            start = datetime.fromtimestamp(int(s["startTimeGmt"]) / 1000, tz=timezone.utc)
            md = s.get("movingDuration")
            duration = s.get("duration") or 0
            yield RawActivity(
                source="garmin",
                source_id=str(s["activityId"]),
                name=s.get("name") or "Untitled",
                type_raw=s.get("activityType") or "other",
                start_time=start,
                distance_m=(s.get("distance") or 0) / 100.0,
                moving_time_s=int((md if md is not None else duration) / 1000),
                elevation_gain_m=(s.get("elevationGain") or 0) / 100.0,
                track=self._track_for(start.timestamp(), index),
            )


def main():
    ap = argparse.ArgumentParser(description="Import a Garmin bulk export into the SQLite store.")
    ap.add_argument("export_root", help="unzipped Garmin export dir (contains DI_CONNECT/)")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--simplify-m", type=float, default=0.5)
    args = ap.parse_args()
    print(f"garmin_import: {GarminImporter(args.export_root, args.db, simplify_tol_m=args.simplify_m).run()}")


if __name__ == "__main__":
    main()
