"""One writer cycle against the database in R2: pull, work, upload if changed.

The master database lives at ``db/activities.sqlite``. A run pulls it, lets
``work`` change the local copy, then uploads it with ``If-Match`` on the etag it
pulled. If another writer got there first, R2 answers 412: the run throws its
copy away, pulls the new database and redoes the work, up to WRITE_ATTEMPTS
times. Nothing is ever written over a database this run has not seen.

A successful upload also writes ``db/snapshots/<today>.sqlite`` and prunes old
snapshots. With a local archive the database is simply used in place.
"""
import hashlib
import os
import re
import sys
import tempfile
from collections.abc import Callable
from typing import TypeVar

from ingest.archive import Archive, is_remote
from ingest.objstore import ObjectStore, PreconditionFailed

T = TypeVar("T")

DB_KEY = "db/activities.sqlite"
SNAPSHOT_PREFIX = "db/snapshots/"
WRITE_ATTEMPTS = 3  # give up after 3 attempts
SNAPSHOT_DAYS = 30  # keep the last 30 daily snapshots plus the first of each month

EXIT_WRITE_CONFLICT = 5
EXIT_NO_REMOTE_DB = 6

_SNAPSHOT_KEY = re.compile(re.escape(SNAPSHOT_PREFIX) + r"(\d{4}-\d{2}-\d{2})\.sqlite$")


def pull(store: ObjectStore, dest: str) -> str | None:
    """Write the remote database to dest and return its etag; None if R2 has none."""
    try:
        data, etag = store.get(DB_KEY)
    except KeyError:
        return None
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with open(dest, "wb") as fh:
        fh.write(data)
    return etag


def snapshots_to_delete(dates: list[str]) -> list[str]:
    """Dates (YYYY-MM-DD) outside the SNAPSHOT_DAYS newest and the oldest of each month."""
    ordered = sorted(set(dates))
    keep = set(ordered[-SNAPSHOT_DAYS:])
    first_of_month: dict[str, str] = {}
    for d in ordered:
        first_of_month.setdefault(d[:7], d)
    keep |= set(first_of_month.values())
    return [d for d in ordered if d not in keep]


def _sha256(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _remove(path: str) -> None:
    for p in (path, path + "-journal"):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def working_copy(db_path: str) -> str:
    """A fresh, unique path next to db_path for one pull; the file does not exist yet.

    Unique per call so two processes sharing a db_path (a backfill and a sync, say)
    never delete or truncate each other's working copy.
    """
    directory = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(directory, exist_ok=True)
    fd, path = tempfile.mkstemp(dir=directory, prefix=os.path.basename(db_path) + ".pull-")
    os.close(fd)
    os.remove(path)
    return path


def install(tmp: str, db_path: str) -> None:
    """Replace db_path with the pulled copy at tmp.

    Leftover journal/WAL files of the copy being replaced are removed first, so a
    hot journal from a crashed earlier process is never rolled into the new file.
    """
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    for suffix in ("-journal", "-wal", "-shm"):
        try:
            os.remove(db_path + suffix)
        except FileNotFoundError:
            pass
    os.replace(tmp, db_path)


def _prune_snapshots(store: ObjectStore) -> None:
    by_date = {}
    for key, _ in store.list(SNAPSHOT_PREFIX):
        m = _SNAPSHOT_KEY.fullmatch(key)
        if m:
            by_date[m.group(1)] = key
    for d in snapshots_to_delete(list(by_date)):
        store.delete(by_date[d])


def _report_changed(changed: bool) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as fh:
            fh.write(f"db_changed={'true' if changed else 'false'}\n")


def run(db_path: str, archive: Archive, work: Callable[[str], T], *, today: str, init_db: bool = False) -> T:
    if not is_remote(archive):
        return work(db_path)

    store = archive.store
    tmp = None
    changed = False
    try:
        for attempt in range(1, WRITE_ATTEMPTS + 1):
            if tmp:
                _remove(tmp)
            tmp = working_copy(db_path)
            etag = pull(store, tmp)
            if etag is None and not init_db:
                print(
                    f"R2 has no database at {DB_KEY}: run an import with --init-db first (see migration)",
                    file=sys.stderr,
                )
                raise SystemExit(EXIT_NO_REMOTE_DB)
            before = _sha256(tmp)
            result = work(tmp)
            after = _sha256(tmp)
            if after is None or after == before:
                if after is not None:
                    install(tmp, db_path)
                return result
            with open(tmp, "rb") as fh:
                data = fh.read()
            try:
                if etag is None:
                    store.put(DB_KEY, data, if_none_match="*")
                else:
                    store.put(DB_KEY, data, if_match=etag)
            except PreconditionFailed:
                print(
                    f"R2 database changed during the run (attempt {attempt}/{WRITE_ATTEMPTS}); redoing",
                    file=sys.stderr,
                )
                continue
            # The master is updated; the local copy follows it even if a snapshot step fails.
            install(tmp, db_path)
            changed = True
            store.put(f"{SNAPSHOT_PREFIX}{today}.sqlite", data)
            _prune_snapshots(store)
            return result
        print(
            f"R2 kept rejecting the database upload ({WRITE_ATTEMPTS} attempts); another writer is busy. "
            "Nothing was uploaded: run again.",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_WRITE_CONFLICT)
    finally:
        if tmp:
            _remove(tmp)
        _report_changed(changed)
