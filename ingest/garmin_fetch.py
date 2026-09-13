"""Live Garmin Connect fetch. Feeds the shared normalize/dedupe/store engine.
See .claude/specs/2026-09-12-garmin-fetch-design.md."""
import argparse
import os
import shutil
import sys
import tempfile
import time
import warnings
from datetime import datetime, timezone

from .base import BaseFetcher
from .model import RawActivity
from . import store


def gmt_to_dt(s: str) -> datetime:
    """'YYYY-MM-DD HH:MM:SS' (genuinely GMT) -> tz-aware UTC datetime."""
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def gmt_to_epoch(s: str) -> int:
    return int(gmt_to_dt(s).timestamp())


def extract_track(detail: dict) -> list[tuple[float, float]]:
    """geoPolylineDTO.polyline -> [(lat, lon)]; [] when absent."""
    pts = ((detail or {}).get("geoPolylineDTO") or {}).get("polyline") or []
    return [(p["lat"], p["lon"]) for p in pts]


def filter_after(items: list[dict], after_epoch: int) -> list[dict]:
    """Keep list items strictly after the high-water epoch."""
    return [i for i in items if gmt_to_epoch(i["startTimeGMT"]) > after_epoch]


def list_item_to_raw(item: dict, track: list[tuple[float, float]]) -> RawActivity:
    return RawActivity(
        source="garmin",
        source_id=str(item["activityId"]),
        name=item.get("activityName") or "",
        type_raw=item["activityType"]["typeKey"],
        start_time=gmt_to_dt(item["startTimeGMT"]),
        distance_m=float(item.get("distance") or 0),
        moving_time_s=int(item.get("movingDuration") or item.get("duration") or 0),
        elevation_gain_m=float(item.get("elevationGain") or 0),
        track=track,
        source_file="garmin-api",
    )


PAGE_SIZE = 100
MAXCHART = 1        # 0 is rejected; polyline count is independent of maxchart
MAXPOLY = 20000     # longest track seen 3419; import-simplify thins anyway
MAX_CONSECUTIVE_FAILURES = 3


class GarminFetcher(BaseFetcher):
    source = "garmin"

    def __init__(self, db_path, *, delay_s: float = 1.0, client=None, **kw):
        super().__init__(db_path, **kw)
        self.delay_s = delay_s
        self._client = client        # test injection; real login when None
        self._tmpdir = None

    # --- auth -------------------------------------------------------------
    def _login(self):
        """Token-only login. GARMIN_TOKEN (JSON blob) or GARMINTOKENS (dir).
        Exits 2 (no creds) / 3 (rejected). No password fallback."""
        from garminconnect import Garmin
        blob = os.environ.get("GARMIN_TOKEN")
        tokdir = os.environ.get("GARMINTOKENS")
        if blob:
            self._tmpdir = tempfile.mkdtemp()
            with open(os.path.join(self._tmpdir, "garmin_tokens.json"), "w") as fh:
                fh.write(blob)
            tokdir = self._tmpdir
        elif not tokdir:
            print("no GARMIN_TOKEN / GARMINTOKENS set; run `npm run auth`", file=sys.stderr)
            raise SystemExit(2)
        g = Garmin()
        try:
            g.login(tokdir)
        except Exception as e:
            print(f"garmin token rejected ({e}); re-run `npm run auth` and update "
                  "GARMIN_TOKEN", file=sys.stderr)
            raise SystemExit(3)
        return g

    # --- thin API wrappers (overridable / injectable) --------------------
    def _list_page(self, client, offset):
        return client.get_activities(offset, PAGE_SIZE)

    def _detail(self, client, activity_id):
        return client.get_activity_details(activity_id, MAXCHART, MAXPOLY)

    # --- orchestration ----------------------------------------------------
    def activities(self):
        client = self._client or self._login()

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
            page = self._list_page(client, offset)
            if not page:
                break
            items.extend(page)
            oldest = gmt_to_epoch(page[-1]["startTimeGMT"])   # newest-first list
            if len(page) < PAGE_SIZE or oldest <= after_epoch:
                break
            offset += PAGE_SIZE
            time.sleep(self.delay_s)

        failures = 0
        for item in filter_after(items, after_epoch):
            track = []
            if item.get("hasPolyline"):
                time.sleep(self.delay_s)
                try:
                    track = extract_track(self._detail(client, item["activityId"]))
                    failures = 0
                except Exception as e:
                    failures += 1
                    warnings.warn(f"detail fetch failed for {item['activityId']}: {e}")
                    if failures >= MAX_CONSECUTIVE_FAILURES:
                        warnings.warn("consecutive detail failures; stopping run")
                        break
                    continue  # don't store a GPS activity without its track; retry next run
            yield list_item_to_raw(item, track)


def main():
    ap = argparse.ArgumentParser(description="Live Garmin Connect fetch into the SQLite store.")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--simplify-m", type=float, default=0.5)
    args = ap.parse_args()
    f = GarminFetcher(args.db, simplify_tol_m=args.simplify_m)
    try:
        f._client = f._login()      # fail loud on missing/rejected token
        print(f"garmin_fetch: {f.run()}")
    finally:
        out = os.environ.get("GARMIN_TOKEN_OUT")
        if out and f._client is not None:
            with open(out, "w") as fh:
                fh.write(f._client.client.dumps())  # possibly-rotated blob CI diffs
        if f._tmpdir:
            shutil.rmtree(f._tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
