"""The one path from source records to the database, shared by the
importers, the Garmin fetch and rebuilds: parse file -> normalize to
SourceActivity -> match -> recompute."""
import importlib
from datetime import datetime
import sys
import warnings
from typing import Callable, Iterable

from . import db, matcher, merge
from .archive import Archive
from .model import SourceActivity
from .parse import ParsedFile
from .parse.dispatch import parse_bytes
from .records import EXPORT_CLOCK_MARGIN, SourceRecord, earliest_observed

Mapper = Callable[[SourceRecord, "ParsedFile | None"], SourceActivity]

_MAPPERS: dict[str, Mapper] = {}

# where each origin kind's mapper is registered, so a rebuild can find it
_MAPPER_MODULES = {"strava_export": "ingest.strava_import",
                   "garmin_export": "ingest.garmin_import",
                   "garmin_api": "ingest.garmin_fetch"}


def register(kind: str, mapper: Mapper) -> None:
    _MAPPERS[kind] = mapper


def _mapper(kind: str) -> Mapper:
    if kind not in _MAPPERS and kind in _MAPPER_MODULES:
        importlib.import_module(_MAPPER_MODULES[kind])
    return _MAPPERS[kind]


def to_source(rec: SourceRecord, archive: Archive) -> SourceActivity:
    """Parse the record's file (a parse failure warns and leaves parsed=None)
    and map the record through its origin kind's mapper."""
    parsed = None
    if rec.file_sha256 and rec.file_name:
        try:
            parsed = parse_bytes(rec.file_name, archive.get_blob(rec.file_sha256))
        except Exception as e:  # any corrupt or truncated file: keep the activity without streams
            warnings.warn(f"unreadable activity file {rec.file_name}: {e}")
    src = _mapper(rec.origin["kind"])(rec, parsed)
    src.observed_at = earliest_observed(rec)   # undeletes only when surely after the deletion
    return src


def _raw_file(conn, archive, sha, kind, provider, ref, name, fetched_at):
    if conn.execute("SELECT 1 FROM raw_files WHERE sha256=?", (sha,)).fetchone():
        return
    size = len(archive.get_blob(sha)) if archive.has_blob(sha) else None
    conn.execute("INSERT INTO raw_files (sha256, kind, provider, provider_ref, original_name, size, fetched_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?)", (sha, kind, provider, ref, name, size, fetched_at))


def _record_raw_files(conn, archive, rec: SourceRecord) -> None:
    if rec.file_sha256:
        _raw_file(conn, archive, rec.file_sha256, "activity_file", rec.provider,
                  rec.provider_activity_id, rec.file_name, rec.fetched_at)
    member_kind = "api_response" if rec.origin.get("kind") == "garmin_api" else "export_member"
    for key, sha in sorted(rec.origin.items()):
        if key.endswith("_sha") and sha:
            _raw_file(conn, archive, sha, member_kind, rec.provider, None, None, rec.fetched_at)


def _refresh_calculated_zones(conn) -> None:
    """Zones calculated for one activity borrow limits from the closest
    source with zones anywhere, so recompute them once every source of the
    batch is in: the result then does not depend on apply order."""
    ids = [r[0] for r in conn.execute(
        "SELECT id FROM activities WHERE has_hr = 1 AND "
        "(hr_zone_seconds IS NULL OR calculated LIKE '%\"hr_zone_seconds\"%') ORDER BY id")]
    for aid in ids:
        merge.recompute_activity(conn, aid)


def apply_records(conn, archive: Archive, records: Iterable[SourceRecord], *, now: str) -> dict[str, int]:
    """Normalize, sort by (start_time, provider, id) and reconcile every
    record. Returns insert/update/merge counts."""
    records = list(records)
    sources = []
    for rec in records:
        _record_raw_files(conn, archive, rec)
        sources.append(to_source(rec, archive))
    sources.sort(key=lambda s: (s.start_time, s.provider, s.provider_activity_id))
    counts = {"insert": 0, "update": 0, "merge": 0}
    for src in sources:
        counts[matcher.reconcile(conn, src, now=now)] += 1
    if any(s.hr_zones for s in sources):
        _refresh_calculated_zones(conn)
    return counts


def first_observed(records: Iterable[SourceRecord], provider: str) -> dict[str, str]:
    """By when each of the provider's records surely existed, on the export
    clock (local time read as UTC): the earliest of its exports' as_of and
    its API fetches' fetched_at plus EXPORT_CLOCK_MARGIN. Two exports share
    a clock, so only a fetch needs the margin to compare with an export."""
    out: dict[str, str] = {}
    for r in records:
        if r.provider == provider:
            seen = r.as_of or (datetime.fromisoformat(r.fetched_at) + EXPORT_CLOCK_MARGIN).isoformat()
            if r.provider_activity_id not in out or _before(seen, out[r.provider_activity_id]):
                out[r.provider_activity_id] = seen
    return out


def _before(a: str, b: str) -> bool:
    return datetime.fromisoformat(a) < datetime.fromisoformat(b)


def mark_missing_deleted(conn, provider: str, seen_ids: set[str], start: str, end: str, *, now: str,
                         as_of: str | None = None, first_observed: dict[str, str] | None = None) -> int:
    """A list or export observed at `as_of` (default `now`) that lacks a record
    within its date range deleted it: set deleted_at to `as_of` on such
    records and recompute their activities. Records first observed after
    `as_of` are left alone, since the list could not have had them. Records
    seen again are undeleted, unless the deletion was observed later than
    `as_of`. An export's `as_of` is on the export clock (see first_observed),
    so it undeletes only deletions dated before its earliest possible real
    moment. Returns the number newly deleted."""
    when = as_of or now
    surely_after = (datetime.fromisoformat(as_of) - EXPORT_CLOCK_MARGIN).isoformat() if as_of else now
    first_observed = first_observed or {}
    seen_ids = set(seen_ids)
    touched = set()
    for r in conn.execute("SELECT provider_activity_id, activity_id, deleted_at FROM activity_sources "
                          "WHERE provider=?", (provider,)).fetchall():
        pid = r["provider_activity_id"]
        if pid in seen_ids and r["deleted_at"] is not None and _before(r["deleted_at"], surely_after):
            conn.execute("UPDATE activity_sources SET deleted_at=NULL WHERE provider=? AND provider_activity_id=?",
                         (provider, pid))
            touched.add(r["activity_id"])
    rows = conn.execute(
        "SELECT provider_activity_id, activity_id FROM activity_sources WHERE provider=? AND deleted_at IS NULL "
        "AND start_time >= ? AND start_time <= ?", (provider, start, end)).fetchall()
    missing = [r for r in rows if r["provider_activity_id"] not in seen_ids
               and not _before(when, first_observed.get(r["provider_activity_id"], when))]
    for r in missing:
        conn.execute("UPDATE activity_sources SET deleted_at=? WHERE provider=? AND provider_activity_id=?",
                     (when, provider, r["provider_activity_id"]))
        touched.add(r["activity_id"])
    for aid in sorted(touched):
        merge.recompute_activity(conn, aid)
    return len(missing)


def open_for_write(db_path: str, archive: Archive, *, now: str):
    """Open the database for a writer: an older v2 schema is rebuilt from the
    archive first; a v1 database stops the run with exit code 4."""
    from .rebuild import rebuild
    try:
        return db.open_db(db_path)
    except db.NeedsRebuild:
        rebuild(db_path, archive, now=now)
        return db.open_db(db_path)
    except db.SchemaMismatch:
        print(f"v1 database at {db_path}: import fresh exports into a new database (see migration)",
              file=sys.stderr)
        raise SystemExit(4)
