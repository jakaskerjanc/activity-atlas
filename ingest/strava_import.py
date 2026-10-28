"""Import a Strava bulk export (zip, or an unzipped folder for development):
archive the export and every file read, write a source record per CSV row,
then apply them through the engine."""
import argparse
import csv
import gzip
import io
import os
import warnings
from datetime import datetime, timezone

from . import engine
from .archive import Archive, open_archive
from .export_reader import (ExportReader, archive_export, export_made_at, is_older_export,
                            newest_export_as_of, now_iso)
from .merge import iso
from .model import REPORTED_KEYS, SourceActivity
from .normalize import canonical_type
from .parse import ParsedFile
from .records import SourceRecord, latest

_DATE_FMTS = ("%b %d, %Y, %I:%M:%S %p", "%b %d, %Y, %H:%M:%S")

CSV_FIELDS = {"Activity ID": "id", "Activity Date": "start", "Activity Name": "name",
    "Activity Type": "type", "Elapsed Time": "elapsed_s", "Moving Time": "moving_s",
    "Distance": "distance_m", "Elevation Gain": "elevation_gain_m",
    "Elevation Loss": "elevation_loss_m", "Average Heart Rate": "avg_hr",
    "Max Heart Rate": "max_hr", "Average Cadence": "avg_cadence", "Max Cadence": "max_cadence",
    "Average Watts": "avg_power", "Max Watts": "max_power", "Calories": "calories",
    "Activity Gear": "gear", "Filename": "file"}

_CSV_KEY = {v: k for k, v in CSV_FIELDS.items()}


def _parse_date(s: str) -> datetime:
    for fmt in _DATE_FMTS:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"unrecognized Strava date: {s!r}")


def _num(s) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def record_to_source(rec: SourceRecord, parsed: ParsedFile | None) -> SourceActivity:
    """CSV values first, then the activity file's own summary."""
    row = rec.summary
    file_summary = parsed.summary if parsed else {}

    def value(key):
        csv_value = _num(row.get(_CSV_KEY[key])) if key in _CSV_KEY else None
        return csv_value if csv_value is not None else file_summary.get(key)

    gear = (row.get("Activity Gear") or "").strip()
    return SourceActivity(
        provider="strava",
        provider_activity_id=rec.provider_activity_id,
        name=(row.get("Activity Name") or "Untitled").strip(),
        type=canonical_type((row.get("Activity Type") or "Workout").strip()),
        start_time=_parse_date(row["Activity Date"].strip()),
        elapsed_s=value("elapsed_s"),
        moving_s=value("moving_s"),
        distance_m=value("distance_m"),
        utc_offset_s=parsed.utc_offset_s if parsed else None,
        reported={k: value(k) for k in REPORTED_KEYS},
        hr_zones=parsed.hr_zones if parsed else None,
        gear=[gear] if gear else [],
        summary=row,
        file_sha256=rec.file_sha256,
        parsed=parsed,
        fetched_at=rec.fetched_at,
    )


engine.register("strava_export", record_to_source)


class StravaImporter:
    def __init__(self, export_path: str, db_path: str, archive: Archive, *, now: str | None = None):
        self.export_path = export_path
        self.db_path = db_path
        self.archive = archive
        self.now = now or now_iso()

    def _file_blob(self, export: ExportReader, fname: str):
        """(sha, name without .gz) of the activity file, or (None, None)."""
        member = export.find(fname) if fname else None
        if member is None:
            if fname:
                warnings.warn(f"activity file {fname} not found in export")
            return None, None
        data, name = export.read(member), os.path.basename(member)
        if name.lower().endswith(".gz"):
            try:
                data, name = gzip.decompress(data), name[:-3]
            except (OSError, EOFError) as e:
                warnings.warn(f"cannot gunzip {member}: {e}; storing it as is")
        return self.archive.put_blob(data), name

    def run(self) -> dict[str, int]:
        export_key = archive_export(self.archive, "strava", self.export_path, self.now[:10])
        made = export_made_at(self.export_path)
        older = is_older_export("strava", made, newest_export_as_of(self.archive, "strava"))
        export = ExportReader(self.export_path)
        try:
            csv_member = export.find("activities.csv")
            if csv_member is None:
                raise SystemExit(f"no activities.csv in {self.export_path}")
            csv_bytes = export.read(csv_member)
            csv_sha = self.archive.put_blob(csv_bytes)
            # DictReader keeps the LAST of any duplicate column -> meters/seconds.
            reader = csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"), newline=""))
            absent = [h for h in CSV_FIELDS if h not in (reader.fieldnames or [])]
            if absent:
                warnings.warn(f"activities.csv: mapped headers absent: {', '.join(absent)}")
            seen, starts = set(), []
            for row in reader:
                row = {k: v for k, v in row.items() if k is not None}
                pid = row["Activity ID"].strip()
                sha, name = self._file_blob(export, (row.get("Filename") or "").strip())
                self.archive.put_record(SourceRecord(
                    "strava", pid, self.now, row, sha, name,
                    {"kind": "strava_export", "export_key": export_key, "csv_sha": csv_sha}, made))
                seen.add(pid)
                starts.append(_parse_date(row["Activity Date"].strip()))
        finally:
            export.close()

        conn = engine.open_for_write(self.db_path, self.archive, now=self.now)
        try:
            records = [r for r in latest(self.archive.list_records())
                       if r.provider == "strava" and r.provider_activity_id in seen]
            # Deletions first: a re-upload under a new ID can then join the
            # activity its deleted original belonged to.
            if starts and not older:   # an older export cannot say what was deleted since
                engine.mark_missing_deleted(conn, "strava", seen, iso(min(starts)), iso(max(starts)), now=self.now)
            counts = engine.apply_records(conn, self.archive, records, now=self.now)
            conn.commit()
        finally:
            conn.close()
        return counts


def main():
    ap = argparse.ArgumentParser(description="Import a Strava bulk export into the archive and database.")
    ap.add_argument("export", help="Strava export zip (or an unzipped export folder, for development)")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    args = ap.parse_args()
    print(f"strava_import: {StravaImporter(args.export, args.db, open_archive(args.archive)).run()}")


if __name__ == "__main__":
    main()
