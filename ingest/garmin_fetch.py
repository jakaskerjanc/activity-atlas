"""Live Garmin Personal API fetch. Archives every list page, activity ZIP and
activity file, writes a source record per activity, and applies them through
the engine. See docs/2026-10-24-garmin-personal-api-design.md."""
import argparse
import io
import os
import sys
import time
import warnings
import zipfile
from datetime import datetime, timezone
from typing import NoReturn

from . import engine
from .archive import Archive, open_archive
from .export_reader import now_iso
from .garmin_api import GarminAuthError, GarminPersonalApi, MissingApiKey, parse_activity_list
from .model import REPORTED_KEYS, SourceActivity
from .normalize import canonical_type
from .parse import ParsedFile
from .records import SourceRecord


def gmt_to_dt(s: str) -> datetime:
    """'YYYY-MM-DD HH:MM:SS' (genuinely GMT) -> tz-aware UTC datetime."""
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def gmt_to_epoch(s: str) -> int:
    return int(gmt_to_dt(s).timestamp())


def filter_after(items: list[dict], after_epoch: int) -> list[dict]:
    """Keep list items strictly after the high-water epoch."""
    return [i for i in items if gmt_to_epoch(i["startTimeGMT"]) > after_epoch]


def extract_activity_file(data: bytes) -> tuple[str, bytes]:
    """(basename, bytes) of the activity file in a Personal API activity ZIP.

    Prefers .fit, then .tcx, then .gpx (case-insensitive); ignores directory
    entries and __MACOSX metadata. Raises ValueError when none is present.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        files = [i.filename for i in zf.infolist()
                 if not i.is_dir() and not i.filename.startswith("__MACOSX/")]
        for ext in (".fit", ".tcx", ".gpx"):
            for name in files:
                if name.lower().endswith(ext):
                    return os.path.basename(name), zf.read(name)
    raise ValueError("no .fit/.tcx/.gpx file in the activity ZIP")


def has_gps_hint(item: dict) -> bool:
    """True when the activity is worth downloading for geometry.

    Older payloads carry hasPolyline; the live Personal API DTO does not, so
    fall back to the start coordinates (null for indoor activities).
    """
    if item.get("hasPolyline"):
        return True
    return (item.get("startLatitude") is not None
            and item.get("startLongitude") is not None)


# DTO fields in metres and seconds (no scaling). activityName,
# activityType.typeKey, startTimeGMT, startTimeLocal, distance, duration,
# movingDuration and elevationGain are verified; elevationLoss, averageHR,
# maxHR and calories are mapped when present but their names are unverified.
_REPORTED = {"elevation_gain_m": "elevationGain", "elevation_loss_m": "elevationLoss",
             "avg_hr": "averageHR", "max_hr": "maxHR", "calories": "calories"}


def _num(item: dict, key: str) -> float | None:
    v = item.get(key)
    return float(v) if isinstance(v, (int, float)) else None


def record_to_source(rec: SourceRecord, parsed: ParsedFile | None) -> SourceActivity:
    """DTO values first, then the activity file's own summary."""
    item = rec.summary
    file_summary = parsed.summary if parsed else {}

    def value(key, own):
        return own if own is not None else file_summary.get(key)

    start = gmt_to_dt(item["startTimeGMT"])
    offset = parsed.utc_offset_s if parsed else None
    if item.get("startTimeLocal"):
        offset = int((gmt_to_dt(item["startTimeLocal"]) - start).total_seconds())
    elapsed, moving = _num(item, "duration"), _num(item, "movingDuration")
    reported = {k: file_summary.get(k) for k in REPORTED_KEYS}
    for key, field in _REPORTED.items():
        reported[key] = value(key, _num(item, field))
    return SourceActivity(
        provider="garmin",
        provider_activity_id=rec.provider_activity_id,
        name=item.get("activityName") or "Untitled",
        type=canonical_type((item.get("activityType") or {}).get("typeKey") or "other"),
        start_time=start,
        elapsed_s=value("elapsed_s", elapsed),
        moving_s=value("moving_s", moving if moving is not None else elapsed),
        distance_m=value("distance_m", _num(item, "distance")),
        utc_offset_s=offset,
        reported=reported,
        hr_zones=parsed.hr_zones if parsed else None,
        gear=[],
        summary=item,
        file_sha256=rec.file_sha256,
        parsed=parsed,
        fetched_at=rec.fetched_at,
    )


engine.register("garmin_api", record_to_source)


PAGE_SIZE = 100
MAX_CONSECUTIVE_FAILURES = 3


def auth_rejected(error: Exception) -> NoReturn:
    """Print the shared rejected-key guidance and exit 3."""
    print("garmin_fetch: Personal API key rejected; create a fresh key in "
          "Garmin Connect (Settings -> Personal API Key): "
          "https://connect.garmin.com/app/settings/personalApiToken "
          f"({error})", file=sys.stderr)
    raise SystemExit(3)


class GarminFetcher:
    def __init__(self, db_path: str, archive: Archive, *, delay_s: float = 1.0, client=None,
                 key_file=None, page_size: int = PAGE_SIZE, now: str | None = None):
        self.db_path = db_path
        self.archive = archive
        self.delay_s = delay_s
        self._client = client        # test injection; authenticate() when None
        self._key_file = key_file
        self.page_size = page_size
        self.now = now or now_iso()

    # --- auth -------------------------------------------------------------
    def authenticate(self) -> GarminPersonalApi:
        """Resolve the API client. Exits 2 (no key) / 3 (rejected key).

        With an injected client just returns it — no network, and the double
        may not even have an authenticate() of its own.
        """
        if self._client is not None:
            return self._client
        try:
            client = GarminPersonalApi(key_file=self._key_file)
            client.authenticate()    # fail loud before touching the store
        except MissingApiKey as e:
            print("garmin_fetch: no Personal API key; pass --api-key-file or set "
                  f"GARMIN_PERSONAL_API_KEY in the environment or .env ({e})", file=sys.stderr)
            raise SystemExit(2)
        except GarminAuthError as e:
            auth_rejected(e)
        self._client = client
        return client

    # --- orchestration ----------------------------------------------------
    @staticmethod
    def high_water(conn) -> str | None:
        """Newest stored Garmin record start. Only Garmin's own records count,
        so a newer Strava activity cannot hide a Garmin one that matches it."""
        row = conn.execute("SELECT MAX(start_time) FROM activity_sources WHERE provider='garmin'").fetchone()
        return row[0] if row and row[0] else None

    def _list(self, client, after_epoch: int) -> list[tuple[dict, str]]:
        """[(item, sha of its list page)], newest first, archiving every page."""
        items, offset = [], 0
        while True:
            body = client.list_activities_raw(offset, self.page_size)
            page = parse_activity_list(body, f"list page at offset {offset}")
            if not page:
                break
            sha = self.archive.put_blob(body)
            items.extend((item, sha) for item in page)
            oldest = gmt_to_epoch(page[-1]["startTimeGMT"])   # newest-first list
            if len(page) < self.page_size or oldest <= after_epoch:
                break
            offset += self.page_size
            time.sleep(self.delay_s)
        return items

    def _records(self, client, after_epoch: int) -> list[SourceRecord]:
        records, failures = [], 0
        for item, list_sha in self._list(client, after_epoch):
            if gmt_to_epoch(item["startTimeGMT"]) <= after_epoch:
                continue
            origin = {"kind": "garmin_api", "list_sha": list_sha, "zip_sha": None}
            file_sha = file_name = None
            if has_gps_hint(item):
                time.sleep(self.delay_s)
                try:
                    data = client.download_activity(item["activityId"])
                    origin["zip_sha"] = self.archive.put_blob(data)
                    file_name, raw = extract_activity_file(data)
                    file_sha = self.archive.put_blob(raw)
                    failures = 0
                except GarminAuthError:
                    raise          # the key died; retrying the page won't help
                except Exception as e:
                    failures += 1
                    warnings.warn(f"download failed for {item['activityId']}: {e}")
                    if failures >= MAX_CONSECUTIVE_FAILURES:
                        warnings.warn("consecutive download failures; stopping run")
                        break
                    # Don't store a GPS activity without its file. It is retried
                    # next run only while it stays above the Garmin high-water
                    # mark; a newer stored Garmin activity moves the mark past it
                    # and the failed item is then missed.
                    continue
            rec = SourceRecord("garmin", str(item["activityId"]), self.now, item,
                               file_sha, file_name, origin)
            self.archive.put_record(rec)
            records.append(rec)
        return records

    def run(self) -> dict[str, int]:
        client = self.authenticate()
        conn = engine.open_for_write(self.db_path, self.archive, now=self.now)
        try:
            hw = self.high_water(conn)
            after_epoch = int(datetime.fromisoformat(hw).timestamp()) if hw else 0
            records = self._records(client, after_epoch)
            counts = engine.apply_records(conn, self.archive, records, now=self.now)
            conn.commit()
        finally:
            conn.close()
        return counts


def main():
    ap = argparse.ArgumentParser(
        description="Fetch Garmin activities via the Personal API into the archive and database.")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    ap.add_argument("--api-key-file", default=None,
                    help="Personal API key file (default: GARMIN_PERSONAL_API_KEY env, "
                         "then GARMIN_PERSONAL_API_KEY in the repo-root .env)")
    args = ap.parse_args()
    f = GarminFetcher(args.db, open_archive(args.archive), key_file=args.api_key_file)
    f.authenticate()            # fail loud on missing/rejected key
    try:
        counts = f.run()
    except GarminAuthError as e:
        auth_rejected(e)        # key expired between startup and the API calls
    print(f"garmin_fetch: {counts}")


if __name__ == "__main__":
    main()
