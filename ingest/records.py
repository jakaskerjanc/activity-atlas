"""Source records: one self-describing snapshot of a provider record (its
summary verbatim plus a pointer to its activity-file blob), as stored in the
archive. Wellness records do the same for wellness inputs (a monitoring FIT,
an API day). The database is rebuilt from these."""
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Iterable


def _canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@dataclass(frozen=True)
class SourceRecord:
    provider: str                 # "strava" | "garmin"
    provider_activity_id: str
    fetched_at: str               # ISO-8601 UTC, seconds
    summary: dict                 # provider record verbatim (CSV row / JSON entry / API DTO)
    file_sha256: str | None       # blob of the decompressed activity file
    file_name: str | None         # e.g. "123.fit" (no .gz)
    origin: dict                  # {"kind": "strava_export"|"garmin_export"|"garmin_api", ...refs}
    as_of: str | None = None      # an export's creation time (ISO UTC); None = use fetched_at

    def _dict(self) -> dict:
        d = asdict(self)
        if d["as_of"] is None:    # absent, so records written before as_of keep their hash and bytes
            del d["as_of"]
        return d

    def content_sha(self) -> str:
        """sha256 of every field except fetched_at, so a re-fetch of an
        unchanged record hashes the same."""
        d = self._dict()
        del d["fetched_at"]
        return hashlib.sha256(_canonical(d)).hexdigest()

    def to_json(self) -> bytes:
        return _canonical(self._dict())

    @staticmethod
    def from_json(data: bytes) -> "SourceRecord":
        return SourceRecord(**json.loads(data))


# An export's as_of comes from zip member times, which are local time read as
# UTC: the real moment lies within this margin of it (UTC-12 to UTC+14).
EXPORT_CLOCK_MARGIN = timedelta(hours=14)


def earliest_observed(r: SourceRecord) -> str:
    """The earliest real (UTC) moment the record's data may have been
    observed: an export's as_of less EXPORT_CLOCK_MARGIN, else fetched_at."""
    if not r.as_of:
        return r.fetched_at
    return (datetime.fromisoformat(r.as_of) - EXPORT_CLOCK_MARGIN).isoformat()


def recency(r: SourceRecord) -> tuple[str, str, str]:
    """Sort key for "newest": when the data was observed (an export's as_of,
    else fetched_at), then fetched_at, then content_sha so a tie never
    depends on listing order."""
    return (r.as_of or r.fetched_at, r.fetched_at, r.content_sha())


def latest(records: Iterable[SourceRecord]) -> list[SourceRecord]:
    """The newest record per (provider, id) by recency."""
    best: dict[tuple[str, str], SourceRecord] = {}
    for r in records:
        key = (r.provider, r.provider_activity_id)
        cur = best.get(key)
        if cur is None or recency(r) > recency(cur):
            best[key] = r
    return [best[k] for k in sorted(best)]


@dataclass(frozen=True)
class WellnessRecord:
    provider: str                 # "garmin"
    source: str                   # "monitoring_fit" | an API endpoint name
    key: str                      # monitoring_fit: the file's sha256; API: the calendar date YYYY-MM-DD
    fetched_at: str               # ISO-8601 UTC, seconds
    blob_sha256: str              # the file / response bytes
    file_name: str | None
    origin: dict                  # {"kind": "garmin_export"|"garmin_api", ...refs}

    def content_sha(self) -> str:
        """sha256 of every field except fetched_at."""
        d = asdict(self)
        del d["fetched_at"]
        return hashlib.sha256(_canonical(d)).hexdigest()

    def to_json(self) -> bytes:
        return _canonical(asdict(self))

    @staticmethod
    def from_json(data: bytes) -> "WellnessRecord":
        return WellnessRecord(**json.loads(data))


def latest_wellness(records: Iterable[WellnessRecord]) -> list[WellnessRecord]:
    """The newest record per (provider, source, key) by fetched_at; a tie
    goes to the larger content_sha so it never depends on listing order."""
    best: dict[tuple[str, str, str], WellnessRecord] = {}
    for r in records:
        key = (r.provider, r.source, r.key)
        cur = best.get(key)
        if cur is None or (r.fetched_at, r.content_sha()) > (cur.fetched_at, cur.content_sha()):
            best[key] = r
    return [best[k] for k in sorted(best)]
