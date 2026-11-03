"""Live Garmin Personal API fetch. Archives every list page, activity ZIP and
activity file, writes a source record per activity, and applies them through
the engine. See docs/2026-10-24-garmin-personal-api-design.md."""
import argparse
import io
import json
import os
import sys
import time
import warnings
import zipfile
from datetime import date, datetime, timedelta, timezone
from typing import NoReturn

from . import engine, merge, writer
from .archive import Archive, open_archive
from .export_reader import now_iso
from .garmin_wellness import fetch_wellness
from .garmin_api import GarminApiError, GarminAuthError, GarminPersonalApi, MissingApiKey, parse_activity_list
from .model import REPORTED_KEYS, SourceActivity
from .normalize import canonical_type
from .parse import ParsedFile
from .records import SourceRecord
from .wellness import apply_wellness


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


# DTO fields in metres and seconds (no scaling). Every mapped name, including
# elevationLoss, averageHR, maxHR and calories, was checked against a live
# DTO and its FIT session on 2026-11-01.
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
RECHECK_DAYS = 30
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
                 key_file=None, page_size: int = PAGE_SIZE, now: str | None = None,
                 wellness_since: str | None = None):
        self.db_path = db_path
        self.archive = archive
        self.delay_s = delay_s
        self._client = client        # test injection; authenticate() when None
        self._key_file = key_file
        self.page_size = page_size
        self.now = now or now_iso()
        self.wellness_since = wellness_since

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

    def _list(self, client, cutoff_epoch: int) -> list[tuple[dict, str]]:
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
            if len(page) < self.page_size or oldest <= cutoff_epoch:
                break
            offset += self.page_size
            time.sleep(self.delay_s)
        return items

    @staticmethod
    def _is_unchanged(conn, item: dict) -> bool:
        """True when the stored record's list DTO equals the listed one."""
        row = conn.execute(
            "SELECT summary_json FROM activity_sources WHERE provider='garmin' AND provider_activity_id=?",
            (str(item["activityId"]),)).fetchone()
        return row is not None and json.loads(row["summary_json"]) == item

    @staticmethod
    def _previous_file(conn, item: dict) -> tuple[str | None, str | None]:
        """The stored activity file of an item whose re-download returned
        none (404 or a ZIP without one), so an edit doesn't drop its streams."""
        row = conn.execute(
            "SELECT s.file_sha256, r.original_name FROM activity_sources s "
            "LEFT JOIN raw_files r ON r.sha256 = s.file_sha256 "
            "WHERE s.provider='garmin' AND s.provider_activity_id=? AND s.file_sha256 IS NOT NULL",
            (str(item["activityId"]),)).fetchone()
        if row is None or not row["original_name"]:
            return None, None
        warnings.warn(f"re-download of {item['activityId']} returned no activity file; keeping its previous file")
        return row["file_sha256"], row["original_name"]

    def _records(self, client, conn, items: list[tuple[dict, str]], cutoff_epoch: int) -> list[SourceRecord]:
        """A record for every new or changed item past the cutoff, with its
        activity file when it has one. A download that fails writes nothing,
        so the item is retried next run while it stays inside the window."""
        records, failures = [], 0
        for item, list_sha in items:
            if gmt_to_epoch(item["startTimeGMT"]) <= cutoff_epoch or self._is_unchanged(conn, item):
                continue
            origin = {"kind": "garmin_api", "list_sha": list_sha, "zip_sha": None}
            file_sha = file_name = None
            time.sleep(self.delay_s)
            try:
                data = client.download_activity(item["activityId"])
                origin["zip_sha"] = self.archive.put_blob(data)
                try:
                    file_name, raw = extract_activity_file(data)
                except ValueError:
                    raw = None     # the ZIP holds no activity file
                if raw is not None:
                    file_sha = self.archive.put_blob(raw)
                failures = 0
            except GarminAuthError:
                raise          # the key died; retrying the page won't help
            except Exception as e:
                if not (isinstance(e, GarminApiError) and e.status == 404):
                    failures += 1
                    warnings.warn(f"download failed for {item['activityId']}: {e}")
                    if failures >= MAX_CONSECUTIVE_FAILURES:
                        warnings.warn("consecutive download failures; stopping run")
                        break
                    continue
                # A manual activity has no file (404). Keep it without streams;
                # its unchanged DTO won't retry it.
                failures = 0
            if file_sha is None:
                file_sha, file_name = self._previous_file(conn, item)
            rec = SourceRecord("garmin", str(item["activityId"]), self.now, item,
                               file_sha, file_name, origin)
            self.archive.put_record(rec)
            records.append(rec)
        return records

    def _mark_deleted(self, conn, items: list[tuple[dict, str]]) -> int:
        """Mark Garmin activities in the re-check window that the list no
        longer has as deleted; activities listed again are undeleted."""
        now = datetime.fromisoformat(self.now)
        start, end = merge.iso(now - timedelta(days=RECHECK_DAYS)), merge.iso(now)
        lo, hi = int((now - timedelta(days=RECHECK_DAYS)).timestamp()), int(now.timestamp())
        seen = {str(item["activityId"]) for item, _ in items
                if lo <= gmt_to_epoch(item["startTimeGMT"]) <= hi}
        if not seen and conn.execute(
                "SELECT 1 FROM activity_sources WHERE provider='garmin' AND deleted_at IS NULL "
                "AND start_time >= ? AND start_time <= ?", (start, end)).fetchone():
            warnings.warn(f"re-check listed no Garmin activities in the last {RECHECK_DAYS} days; "
                          "marking nothing deleted")
            return 0
        return engine.mark_missing_deleted(conn, "garmin", seen, start, end, now=self.now)

    def run(self) -> dict[str, int]:
        client = self.authenticate()
        conn = engine.open_for_write(self.db_path, self.archive, now=self.now)
        try:
            hw = self.high_water(conn)
            cutoff_epoch = 0
            if hw:
                recheck = int((datetime.fromisoformat(self.now) - timedelta(days=RECHECK_DAYS)).timestamp())
                cutoff_epoch = min(int(datetime.fromisoformat(hw).timestamp()), recheck)
            items = self._list(client, cutoff_epoch)
            records = self._records(client, conn, items, cutoff_epoch)
            deleted = self._mark_deleted(conn, items)
            counts = engine.apply_records(conn, self.archive, records, now=self.now)
            conn.commit()
            # after the commit, so a wellness failure leaves the activities stored (main uploads them under R2)
            wellness_days = 0

            def save(batch):    # per chunk of days, so an interrupted backfill keeps its progress (locally, and uploaded under R2)
                nonlocal wellness_days
                wellness_days += apply_wellness(conn, self.archive, batch)
                conn.commit()
            fetch_wellness(client, self.archive, conn, now=self.now, since=self.wellness_since,
                           delay_s=self.delay_s, on_batch=save)
        finally:
            conn.close()
        return {**counts, "deleted": deleted, "wellness_days": wellness_days}


def _iso_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {value!r}") from None


def main():
    ap = argparse.ArgumentParser(
        description="Fetch Garmin activities via the Personal API into the archive and database.")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    ap.add_argument("--api-key-file", default=None,
                    help="Personal API key file (default: GARMIN_PERSONAL_API_KEY env, "
                         "then GARMIN_PERSONAL_API_KEY in the repo-root .env)")
    ap.add_argument("--wellness-since", default=None, metavar="YYYY-MM-DD", type=_iso_date,
                    help="fetch wellness data from this date (backfill); default: each endpoint's last "
                         "stored day minus 7, or the last 30 days on the first run")
    args = ap.parse_args()
    archive = open_archive(args.archive)
    first = GarminFetcher(args.db, archive, key_file=args.api_key_file, wellness_since=args.wellness_since)
    client = first.authenticate()   # fail loud on missing/rejected key, before any pull

    def work(path):
        # A fresh fetcher per attempt, so a redo after a lost upload race starts clean.
        # A failed run() has already committed what it fetched (run() closes its connection
        # on the way out), so hand the error back instead of raising: writer.run then
        # uploads that progress, and main re-raises the error afterwards.
        try:
            return GarminFetcher(path, archive, key_file=args.api_key_file,
                                 wellness_since=args.wellness_since, client=client).run(), None
        except Exception as e:
            return None, e
    counts, error = writer.run(args.db, archive, work, today=date.today().isoformat())
    if error is not None:
        try:
            raise error
        except GarminAuthError as e:
            auth_rejected(e)    # key expired between startup and the API calls
    print(f"garmin_fetch: {counts}")


if __name__ == "__main__":
    main()
