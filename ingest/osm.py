"""Download OSM named points per country from Overpass and load them.

``places:update SI AT`` fetches every country first; only when all succeed are
the responses stored in the archive and the ``osm_points`` table replaced.
"""
import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from . import engine, writer
from .archive import open_archive
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


def apply_osm(conn: sqlite3.Connection, snapshots: dict[str, bytes]) -> int:
    """Replace each country's rows with its snapshot's points; no commit."""
    total = 0
    for country, data in snapshots.items():
        points = parse_points(data, country)
        conn.execute("DELETE FROM osm_points WHERE country = ?", (country,))
        # OR REPLACE: a feature on a border can be returned for two countries
        conn.executemany(
            "INSERT OR REPLACE INTO osm_points (osm_id, kind, name, lat, lon, ele, country) VALUES (?,?,?,?,?,?,?)",
            [(p.osm_id, p.kind, p.name, p.lat, p.lon, p.ele, country) for p in points])
        total += len(points)
    return total


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
        conn = engine.open_for_write(path, archive, now=now_iso())
        try:
            snapshots = archive.list_osm()
            counts = {c: apply_osm(conn, {c: d}) for c, d in snapshots.items()}
            conn.commit()
            return counts
        finally:
            conn.close()

    counts = writer.run(args.db, archive, work, today=date.today().isoformat())
    for country, n in counts.items():
        print(f"{country}: {n} points")


if __name__ == "__main__":
    main()
