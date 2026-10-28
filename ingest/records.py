"""Source records: one self-describing snapshot of a provider record (its
summary verbatim plus a pointer to its activity-file blob), as stored in the
archive. The database is rebuilt from these."""
import hashlib
import json
from dataclasses import asdict, dataclass
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

    def content_sha(self) -> str:
        """sha256 of every field except fetched_at, so a re-fetch of an
        unchanged record hashes the same."""
        d = asdict(self)
        del d["fetched_at"]
        return hashlib.sha256(_canonical(d)).hexdigest()

    def to_json(self) -> bytes:
        return _canonical(asdict(self))

    @staticmethod
    def from_json(data: bytes) -> "SourceRecord":
        return SourceRecord(**json.loads(data))


def latest(records: Iterable[SourceRecord]) -> list[SourceRecord]:
    """The newest record per (provider, id); a fetched_at tie goes to the
    larger content_sha so the choice never depends on listing order."""
    best: dict[tuple[str, str], SourceRecord] = {}
    for r in records:
        key = (r.provider, r.provider_activity_id)
        cur = best.get(key)
        if cur is None or (r.fetched_at, r.content_sha()) > (cur.fetched_at, cur.content_sha()):
            best[key] = r
    return [best[k] for k in sorted(best)]
