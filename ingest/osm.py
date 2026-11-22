"""Download OSM named points per country from Overpass, and build the points file the refresh names
places from.

``places:update SI AT`` fetches every country first; only when all succeed are the responses stored in
the archive. The points live in their own SQLite file, not in the database: ``points_file`` builds it
from the archive's newest snapshot per country and stores it as ``derived/osm-points/<name>``, named by
those snapshots, so it is built once per set of snapshots and a machine that has it never fetches it
again. Only writers need it; the deploy and the MCP server never do.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from datetime import date

from . import engine, writer
from .archive import Archive, open_archive
from .export_reader import now_iso
from .naming import OsmPoint

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "activity-atlas/0.1 (+https://github.com/jakaskerjanc/activity-atlas)"
REQUEST_GAP_S = 5
# Overpass's own limit for one country's query. Norway (114k points, mostly named lakes)
# took 385 s on 2026-11-12 and runs out at 180 s; Austria takes about 200 s.
QUERY_TIMEOUT_S = 900
_TIMEOUT_S = QUERY_TIMEOUT_S + 60   # the HTTP wait: Overpass's limit plus transfer time

_PLACE_KINDS = ("neighbourhood", "quarter", "suburb", "hamlet", "village")
_ELE = re.compile(r"\s*(\d+(?:[.,]\d+)?)")


class OsmError(Exception):
    pass


def overpass_query(country: str) -> str:
    return f"""[out:json][timeout:{QUERY_TIMEOUT_S}];
area["ISO3166-1"="{country}"][admin_level=2]->.a;
(
  nwr["natural"~"^(peak|saddle)$"]["name"](area.a);
  nwr["mountain_pass"="yes"]["name"](area.a);
  nwr["leisure"="park"]["name"](area.a);
  nwr["natural"="water"]["name"](area.a);
  node["place"~"^(neighbourhood|quarter|suburb|hamlet|village)$"]["name"](area.a);
);
out center tags;
"""


def _kind(tags: dict) -> str | None:
    if tags.get("natural") == "peak":
        return "peak"
    if tags.get("natural") == "saddle" or tags.get("mountain_pass") == "yes":
        return "pass"
    if tags.get("leisure") == "park":
        return "park"
    if tags.get("natural") == "water":
        return "water"
    if tags.get("place") in _PLACE_KINDS:
        return tags["place"]
    return None


def _ele(tags: dict) -> float | None:
    m = _ELE.match(str(tags.get("ele", "")))
    return float(m.group(1).replace(",", ".")) if m else None


def parse_points(data: bytes, country: str) -> list[OsmPoint]:
    try:
        doc = json.loads(data)
    except ValueError as e:
        raise OsmError(f"{country}: not JSON ({data[:80]!r})") from e
    if not isinstance(doc, dict) or not isinstance(doc.get("elements"), list):
        raise OsmError(f"{country}: response has no elements")
    if doc.get("remark"):
        raise OsmError(f"{country}: Overpass remark: {doc['remark']}")
    points = []
    for el in doc["elements"]:
        tags = el.get("tags") or {}
        pos = el if "lat" in el and "lon" in el else el.get("center") or {}
        kind = _kind(tags)
        if not tags.get("name") or kind is None or "lat" not in pos or "lon" not in pos:
            continue
        points.append(OsmPoint(f"{el['type']}/{el['id']}", kind, tags["name"],
                               float(pos["lat"]), float(pos["lon"]), _ele(tags)))
    return points


POINTS_FOLDER = "osm-points"
POINTS_FILE_VERSION = 1
_POINTS_SCHEMA = """
CREATE TABLE osm_points (
  osm_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  ele REAL,
  country TEXT NOT NULL
) WITHOUT ROWID;
"""


def points_file_name(keys: Iterable[str]) -> str:
    """The points file's name for these snapshot keys (one per country), whatever their order."""
    digest = hashlib.sha256("\n".join(sorted(keys)).encode()).hexdigest()[:16]
    return f"v{POINTS_FILE_VERSION}-{digest}.sqlite"


def build_points_file(snapshots: dict[str, bytes], dest: str) -> dict[str, int]:
    """Write every snapshot's points to a new SQLite file at ``dest`` (via a temp file renamed into place).
    Countries go in sorted order with INSERT OR REPLACE, so a feature on a border, which Overpass returns
    for both countries, is kept once, under the later country. Returns the points per country."""
    folder = os.path.dirname(os.path.abspath(dest))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".tmp-", suffix=".sqlite")
    os.close(fd)
    counts = {}
    try:
        conn = sqlite3.connect(tmp)
        try:
            conn.executescript(_POINTS_SCHEMA)
            conn.execute(f"PRAGMA user_version = {POINTS_FILE_VERSION}")
            for country in sorted(snapshots):
                points = parse_points(snapshots[country], country)
                conn.executemany(
                    "INSERT OR REPLACE INTO osm_points (osm_id, kind, name, lat, lon, ele, country)"
                    " VALUES (?,?,?,?,?,?,?)",
                    [(p.osm_id, p.kind, p.name, p.lat, p.lon, p.ele, country) for p in points])
                counts[country] = len(points)
            conn.commit()
        finally:
            conn.close()
        os.replace(tmp, dest)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return counts


def points_file(archive: Archive) -> str | None:
    """The local path of the points file for the archive's newest snapshots: fetched or cached when it is
    stored, else built from the snapshots and stored. None when the archive has no snapshots. A store
    error is raised."""
    keys = archive.newest_osm_keys()
    if not keys:
        return None
    key = f"{POINTS_FOLDER}/{points_file_name(keys.values())}"
    path = archive.get_derived(key)
    if path is not None:
        return path
    with tempfile.TemporaryDirectory() as tmp:
        built = os.path.join(tmp, "points.sqlite")
        build_points_file(archive.list_osm(), built)
        archive.put_derived(key, built)
    return archive.get_derived(key)


def point_counts(path: str) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return dict(conn.execute("SELECT country, COUNT(*) FROM osm_points GROUP BY country ORDER BY country"))
    finally:
        conn.close()


def _http_post(url: str, body: bytes, headers: dict) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def fetch_country(country: str, post=_http_post) -> bytes:
    body = urllib.parse.urlencode({"data": overpass_query(country)}).encode()
    try:
        status, data = post(OVERPASS_URL, body, {"User-Agent": USER_AGENT})
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        reason = e.reason if isinstance(e, urllib.error.URLError) else e
        raise OsmError(f"{country}: could not reach Overpass ({type(e).__name__}: {reason})") from e
    if status != 200:
        raise OsmError(f"{country}: Overpass answered HTTP {status}")
    if not parse_points(data, country):
        raise OsmError(f"{country}: Overpass returned no points")
    return data


def main():
    ap = argparse.ArgumentParser(description="Download OSM named points for countries and load them.")
    ap.add_argument("countries", nargs="+", help="ISO 3166-1 alpha-2 codes, e.g. SI AT")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    args = ap.parse_args()
    countries = [c.upper() for c in args.countries]
    bad = [c for c in countries if not re.fullmatch(r"[A-Z]{2}", c)]
    if bad:
        sys.exit(f"places:update: not a two-letter country code: {', '.join(bad)}")
    archive = open_archive(args.archive)

    fetched = {}
    try:
        for i, country in enumerate(dict.fromkeys(countries)):
            if i:
                time.sleep(REQUEST_GAP_S)
            fetched[country] = fetch_country(country, post=_http_post)
    except OsmError as e:
        sys.exit(f"places:update: {e}; nothing was written")
    for country, data in fetched.items():
        archive.put_osm(country, data, fetched_at=now_iso())

    def work(path):
        # Only opens the database (rebuilding an older one); the run's refresh then builds the points
        # file from the new snapshots and renames places from it.
        engine.open_for_write(path, archive, now=now_iso()).close()

    writer.run(args.db, archive, work, today=date.today().isoformat())
    for country, n in point_counts(points_file(archive)).items():
        print(f"{country}: {n} points")


if __name__ == "__main__":
    main()
