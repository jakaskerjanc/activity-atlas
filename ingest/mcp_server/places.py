"""Place name → coordinates through OpenStreetMap's Nominatim, cached on disk.

Only the search text leaves the machine. Nominatim's usage policy asks for at
most one request a second and a User-Agent that identifies the application.
"""
import json
import os
import tempfile
import time
import urllib.parse
import urllib.request
from collections.abc import Callable

from .activities import counted

URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "strava-on-maps-mcp/0.1 (+https://github.com/jakaskerjanc/strava-on-maps)"
MIN_INTERVAL_S = 1.0
TIMEOUT_S = 10


class PlaceLookupError(Exception):
    """The geocoder could not be reached or refused the request."""


def _http_fetch(url: str, params: dict) -> list[dict]:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _elevation(tags: dict | None) -> int | None:
    try:
        return round(float((tags or {}).get("ele", "")))
    except ValueError:
        return None


def _candidate(p: dict) -> dict:
    return {
        "name": p.get("name") or p.get("display_name", "").split(",")[0],
        "kind": f"{p.get('category', '')}/{p.get('type', '')}",
        "lat": round(float(p["lat"]), 6),
        "lon": round(float(p["lon"]), 6),
        "elevation_m": _elevation(p.get("extratags")),
        "country": p.get("display_name", "").split(",")[-1].strip() or None,
    }


class PlaceFinder:
    def __init__(self, cache_path: str, fetch: Callable[[str, dict], list[dict]] | None = None,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self.cache_path = cache_path
        self._fetch = fetch or _http_fetch
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None
        self._cache: dict[str, list[dict]] | None = None

    def _load(self) -> dict[str, list[dict]]:
        if self._cache is None:
            try:
                with open(self.cache_path, encoding="utf-8") as fh:
                    self._cache = json.load(fh)
            except (OSError, ValueError):
                self._cache = {}
        return self._cache

    def _save(self) -> None:
        directory = os.path.dirname(self.cache_path) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".places-")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(self._cache, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.cache_path)

    def _wait_turn(self) -> None:
        if self._last is not None:
            wait = MIN_INTERVAL_S - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
        self._last = self._clock()

    def find(self, query: str) -> dict:
        key = query.strip().lower()
        if not key:
            raise ValueError("query is empty")
        cache = self._load()
        cached = key in cache
        if not cached:
            self._wait_turn()
            try:
                raw = self._fetch(URL, {"q": query.strip(), "format": "jsonv2", "limit": 5, "extratags": 1})
            except Exception as exc:  # network, HTTP 429, bad JSON: all the same to the caller
                raise PlaceLookupError(
                    f"place lookup failed ({exc}); ask the user for the place or use coordinates you are sure of"
                ) from exc
            cache[key] = [_candidate(p) for p in raw]
            self._save()
        return {
            "data": {"query": query.strip(), "candidates": cache[key], "cached": cached},
            "counted": counted(["OpenStreetMap Nominatim, up to 5 candidates"], len(cache[key])),
        }
