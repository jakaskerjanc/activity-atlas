import argparse
import csv
import os
from datetime import datetime, timezone

from .base import BaseImporter
from .model import RawActivity

_DATE_FMTS = ("%b %d, %Y, %I:%M:%S %p", "%b %d, %Y, %H:%M:%S")


def _parse_date(s: str) -> datetime:
    for fmt in _DATE_FMTS:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"unrecognized Strava date: {s!r}")


def _num(s, default=0.0) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


class StravaImporter(BaseImporter):
    source = "strava"

    def __init__(self, export_root, db_path, **kw):
        super().__init__(db_path, **kw)
        self.root = export_root

    def activities(self):
        with open(os.path.join(self.root, "activities.csv"), newline="", encoding="utf-8") as f:
            # DictReader keeps the LAST of any duplicate column -> meters/seconds.
            for row in csv.DictReader(f):
                yield self._to_raw(row)

    def _to_raw(self, row) -> RawActivity:
        track = []
        fname = (row.get("Filename") or "").strip()
        if fname:
            path = os.path.join(self.root, fname)
            if os.path.exists(path):
                name, fo = self.open_activity_file(path)
                try:
                    track = self.parse_file(name, fo).track
                finally:
                    fo.close()
        return RawActivity(
            source="strava",
            source_id=row["Activity ID"].strip(),
            name=(row.get("Activity Name") or "Untitled").strip(),
            type_raw=(row.get("Activity Type") or "Workout").strip(),
            start_time=_parse_date(row["Activity Date"].strip()),
            distance_m=_num(row.get("Distance")),
            moving_time_s=int(_num(row.get("Moving Time"))),
            elevation_gain_m=_num(row.get("Elevation Gain")),
            track=track,
            source_file=fname or None,
        )


def main():
    ap = argparse.ArgumentParser(description="Import a Strava bulk export into the SQLite store.")
    ap.add_argument("export_root", help="unzipped Strava export dir (contains activities.csv)")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--simplify-m", type=float, default=0.5)
    args = ap.parse_args()
    print(f"strava_import: {StravaImporter(args.export_root, args.db, simplify_tol_m=args.simplify_m).run()}")


if __name__ == "__main__":
    main()
