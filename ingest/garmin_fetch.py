"""Live Garmin Personal API fetch. Feeds the shared normalize/dedupe/store engine.
See docs/2026-10-24-garmin-personal-api-design.md."""
import argparse
import io
import sys
import time
import warnings
import zipfile
from datetime import datetime, timezone
from typing import NoReturn

from .base import BaseFetcher
from .model import RawActivity
from .garmin_api import GarminAuthError, GarminPersonalApi, MissingApiKey
from . import store


def gmt_to_dt(s: str) -> datetime:
    """'YYYY-MM-DD HH:MM:SS' (genuinely GMT) -> tz-aware UTC datetime."""
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def gmt_to_epoch(s: str) -> int:
    return int(gmt_to_dt(s).timestamp())


def filter_after(items: list[dict], after_epoch: int) -> list[dict]:
    """Keep list items strictly after the high-water epoch."""
    return [i for i in items if gmt_to_epoch(i["startTimeGMT"]) > after_epoch]


def extract_track_from_zip(data: bytes) -> list[tuple[float, float]]:
    """Extract [(lat, lon)] from a Personal API activity ZIP download.

    Prefers .fit, then .tcx, then .gpx (case-insensitive); ignores directory
    entries and __MACOSX metadata. Raises ValueError when none is present.
    """
    from .parse.fit import parse_fit
    from .parse.tcx import parse_tcx
    from .parse.gpx import parse_gpx

    parsers = ((".fit", parse_fit), (".tcx", parse_tcx), (".gpx", parse_gpx))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        files = [i.filename for i in zf.infolist()
                 if not i.is_dir() and not i.filename.startswith("__MACOSX/")]
        for ext, parser in parsers:
            for name in files:
                if name.lower().endswith(ext):
                    with zf.open(name) as fh:
                        return parser(fh).track
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


def list_item_to_raw(item: dict, track: list[tuple[float, float]]) -> RawActivity:
    return RawActivity(
        source="garmin",
        source_id=str(item["activityId"]),
        name=item.get("activityName") or "",
        type_raw=(item.get("activityType") or {}).get("typeKey") or "other",
        start_time=gmt_to_dt(item["startTimeGMT"]),
        distance_m=float(item.get("distance") or 0),
        moving_time_s=int(item.get("movingDuration") or item.get("duration") or 0),
        elevation_gain_m=float(item.get("elevationGain") or 0),
        track=track,
        source_file="garmin-personal-api",
    )


PAGE_SIZE = 100
MAX_CONSECUTIVE_FAILURES = 3


def auth_rejected(error: Exception) -> NoReturn:
    """Print the shared rejected-key guidance and exit 3."""
    print("garmin_fetch: Personal API key rejected; create a fresh key in "
          "Garmin Connect (Settings -> Personal API Key): "
          "https://connect.garmin.com/app/settings/personalApiToken "
          f"({error})", file=sys.stderr)
    raise SystemExit(3)


class GarminFetcher(BaseFetcher):
    source = "garmin"

    def __init__(self, db_path, *, delay_s: float = 1.0, client=None, key_file=None,
                 page_size: int = PAGE_SIZE, **kw):
        super().__init__(db_path, **kw)
        self.delay_s = delay_s
        self._client = client        # test injection; authenticate() when None
        self._key_file = key_file
        self.page_size = page_size

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
    def activities(self):
        client = self.authenticate()

        conn = store.connect(self.db_path)
        store.init_schema(conn)
        hw = self.high_water(conn)
        conn.close()
        # NOTE: high_water is MAX(start_time) across ALL sources. A newly-appearing
        # Garmin activity older than a newer other-source row would fall at/below
        # after_epoch and be skipped. Low-probability (daily cadence; strava fetch is
        # a stub) and spec-conformant; documented as an accepted limitation.
        after_epoch = int(datetime.fromisoformat(hw).timestamp()) if hw else 0

        items, offset = [], 0
        while True:
            page = client.list_activities(offset, self.page_size)
            if not page:
                break
            items.extend(page)
            oldest = gmt_to_epoch(page[-1]["startTimeGMT"])   # newest-first list
            if len(page) < self.page_size or oldest <= after_epoch:
                break
            offset += self.page_size
            time.sleep(self.delay_s)

        failures = 0
        for item in filter_after(items, after_epoch):
            track = []
            if has_gps_hint(item):
                time.sleep(self.delay_s)
                try:
                    track = extract_track_from_zip(
                        client.download_activity(item["activityId"]))
                    failures = 0
                except GarminAuthError:
                    raise          # the key died; retrying the page won't help
                except Exception as e:
                    failures += 1
                    warnings.warn(f"download failed for {item['activityId']}: {e}")
                    if failures >= MAX_CONSECUTIVE_FAILURES:
                        warnings.warn("consecutive download failures; stopping run")
                        break
                    # Don't store a GPS activity without its track. It is retried
                    # next run only while it stays above the global high-water
                    # mark; a newer stored activity can move the mark past it and
                    # the failed item is then missed.
                    continue
            yield list_item_to_raw(item, track)


def main():
    ap = argparse.ArgumentParser(
        description="Fetch Garmin activities via the Personal API into the SQLite store.")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--simplify-m", type=float, default=0.5)
    ap.add_argument("--api-key-file", default=None,
                    help="Personal API key file (default: GARMIN_PERSONAL_API_KEY env, "
                         "then GARMIN_PERSONAL_API_KEY in the repo-root .env)")
    args = ap.parse_args()
    f = GarminFetcher(args.db, simplify_tol_m=args.simplify_m, key_file=args.api_key_file)
    f.authenticate()            # fail loud on missing/rejected key
    try:
        counts = f.run()
    except GarminAuthError as e:
        auth_rejected(e)        # key expired between startup and the API calls
    print(f"garmin_fetch: {counts}")


if __name__ == "__main__":
    main()
