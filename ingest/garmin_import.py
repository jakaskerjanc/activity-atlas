"""Import a Garmin bulk export (zip, or an unzipped folder for development):
archive the export, the summarized-activity JSON and each matched activity
FIT, write a source record per summary, then apply them through the engine."""
import argparse
import io
import json
import os
import zipfile
from datetime import datetime, timezone

from . import engine
from .archive import Archive, open_archive
from .export_reader import (ExportReader, archive_export, export_made_at, is_older_export,
                            newest_export_as_of, now_iso)
from .merge import iso
from .model import REPORTED_KEYS, SourceActivity
from .normalize import canonical_type
from .parse import ParsedFile
from .parse.fit import parse_fit
from .records import SourceRecord, latest

# Summary fields scaled to SI. activityId, name, activityType, startTimeGmt,
# distance, duration, movingDuration and elevationGain are verified against a
# real export; elevationLoss, avgHr, maxHr and calories are mapped when
# present but their names are unverified.
_CM, _MS = 0.01, 0.001
_REPORTED = {"elevation_gain_m": ("elevationGain", _CM), "elevation_loss_m": ("elevationLoss", _CM),
             "avg_hr": ("avgHr", 1), "max_hr": ("maxHr", 1), "calories": ("calories", 1)}


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


def _scaled(s: dict, key: str, factor: float) -> float | None:
    v = s.get(key)
    return v * factor if isinstance(v, (int, float)) else None


def record_to_source(rec: SourceRecord, parsed: ParsedFile | None) -> SourceActivity:
    """Summary values first, then the FIT's own summary."""
    s = rec.summary
    file_summary = parsed.summary if parsed else {}

    def value(key, own):
        return own if own is not None else file_summary.get(key)

    elapsed = _scaled(s, "duration", _MS)
    moving = _scaled(s, "movingDuration", _MS)
    reported = {k: file_summary.get(k) for k in REPORTED_KEYS}
    for key, (field, factor) in _REPORTED.items():
        reported[key] = value(key, _scaled(s, field, factor))
    return SourceActivity(
        provider="garmin",
        provider_activity_id=rec.provider_activity_id,
        name=s.get("name") or "Untitled",
        type=canonical_type(s.get("activityType") or "other"),
        start_time=datetime.fromtimestamp(int(s["startTimeGmt"]) / 1000, tz=timezone.utc),
        elapsed_s=value("elapsed_s", elapsed),
        moving_s=value("moving_s", moving if moving is not None else elapsed),
        distance_m=value("distance_m", _scaled(s, "distance", _CM)),
        utc_offset_s=parsed.utc_offset_s if parsed else None,
        reported=reported,
        hr_zones=parsed.hr_zones if parsed else None,
        gear=[],
        summary=s,
        file_sha256=rec.file_sha256,
        parsed=parsed,
        fetched_at=rec.fetched_at,
    )


engine.register("garmin_export", record_to_source)


class GarminImporter:
    def __init__(self, export_path: str, db_path: str, archive: Archive, *,
                 match_window_s: int = 90, now: str | None = None):
        self.export_path = export_path
        self.db_path = db_path
        self.archive = archive
        self.window = match_window_s
        self.now = now or now_iso()

    def _summaries(self, export: ExportReader):
        """[(summary, sha of its JSON member)] for every summarizedActivities file."""
        out = []
        for name in export.names:
            if name.endswith("summarizedActivities.json"):
                data = export.read(name)
                sha = self.archive.put_blob(data)
                out.extend((s, sha) for s in _iter_summaries(json.loads(data)))
        return out

    def _fit_index(self, export: ExportReader):
        """[(epoch_start, name, bytes)] for every activity-type FIT in UploadedFiles."""
        index = []
        for zname in export.names:
            if not (os.path.basename(zname).startswith("UploadedFiles_") and zname.endswith(".zip")):
                continue
            with zipfile.ZipFile(io.BytesIO(export.read(zname))) as zf:
                for name in zf.namelist():
                    if not name.lower().endswith(".fit"):
                        continue
                    raw = zf.read(name)
                    try:
                        if parse_fit(io.BytesIO(raw), geometry=False).file_type != "activity":
                            continue
                        start = parse_fit(io.BytesIO(raw)).start_time
                    except Exception:   # unreadable FIT: not matchable, skip it
                        continue
                    if start is not None:
                        index.append((start.timestamp(), os.path.basename(name), raw))
        return index

    def _fit_for(self, start_epoch: float, index):
        hits = [(abs(epoch - start_epoch), name, raw) for epoch, name, raw in index
                if abs(epoch - start_epoch) <= self.window]
        return min(hits, key=lambda h: (h[0], h[1]))[1:] if hits else (None, None)

    def run(self) -> dict[str, int]:
        made = export_made_at(self.export_path)
        older = is_older_export("garmin", made, newest_export_as_of(self.archive, "garmin"))
        export_key = archive_export(self.archive, "garmin", self.export_path, self.now[:10])
        seen, starts = set(), []
        with ExportReader(self.export_path) as export:
            summaries = self._summaries(export)
            index = self._fit_index(export)
            for s, summary_sha in summaries:
                pid = str(s["activityId"])
                start_epoch = int(s["startTimeGmt"]) / 1000
                name, raw = self._fit_for(start_epoch, index)
                sha = self.archive.put_blob(raw) if raw is not None else None
                self.archive.put_record(SourceRecord(
                    "garmin", pid, self.now, s, sha, name,
                    {"kind": "garmin_export", "export_key": export_key, "summary_sha": summary_sha}, made))
                seen.add(pid)
                starts.append(datetime.fromtimestamp(start_epoch, tz=timezone.utc))

        conn = engine.open_for_write(self.db_path, self.archive, now=self.now)
        try:
            records = [r for r in latest(self.archive.list_records())
                       if r.provider == "garmin" and r.provider_activity_id in seen]
            # Deletions first: a re-upload under a new ID can then join the
            # activity its deleted original belonged to.
            if starts and not older:   # an older export cannot say what was deleted since
                engine.mark_missing_deleted(conn, "garmin", seen, iso(min(starts)), iso(max(starts)), now=self.now)
            counts = engine.apply_records(conn, self.archive, records, now=self.now)
            conn.commit()
        finally:
            conn.close()
        return counts


def main():
    ap = argparse.ArgumentParser(description="Import a Garmin bulk export into the archive and database.")
    ap.add_argument("export", help="Garmin export zip (or an unzipped export folder, for development)")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    args = ap.parse_args()
    print(f"garmin_import: {GarminImporter(args.export, args.db, open_archive(args.archive)).run()}")


if __name__ == "__main__":
    main()
