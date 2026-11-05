"""Keep the local database in step with the master in R2, and say how current it is.

R2's etag for the database (uploaded with a single put) is the MD5 of the file,
so comparing it with the local file's MD5 tells whether anything changed
without downloading 44 MB.
"""
import hashlib
import os
import time
from collections.abc import Callable
from datetime import datetime, timezone

from ingest import writer
from ingest.objstore import ObjectStore

from .database import Database

SYNC_INTERVAL_S = 3600


def _md5(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Syncer:
    def __init__(self, db_path: str, store: ObjectStore | None, interval_s: float = SYNC_INTERVAL_S,
                 clock: Callable[[], float] = time.time):
        self.db_path = db_path
        self.store = store
        self.interval_s = interval_s
        self.clock = clock
        self.last_check: float | None = None
        self.last_outcome = "not checked yet"

    def maybe_sync(self, force: bool = False) -> bool:
        """Check R2 (at most once per interval unless forced); True when a newer
        database was downloaded and installed over the local file."""
        now = self.clock()
        if not force and self.last_check is not None and now - self.last_check < self.interval_s:
            return False
        self.last_check = now
        if self.store is None:
            self.last_outcome = "no R2"
            return False
        tmp = None
        try:
            head = self.store.head(writer.DB_KEY)
            if head is None:
                self.last_outcome = "no database in R2"
                return False
            if head["etag"].strip('"') == _md5(self.db_path):
                self.last_outcome = "up to date"
                return False
            tmp = writer.working_copy(self.db_path)
            if writer.pull(self.store, tmp) is None:
                self.last_outcome = "no database in R2"
                return False
            writer.install(tmp, self.db_path)
            tmp = None
            self.last_outcome = "downloaded"
            return True
        except Exception as exc:  # network, credentials: answer from the local copy
            self.last_outcome = f"failed: {exc}"
            return False
        finally:
            if tmp and os.path.exists(tmp):
                os.remove(tmp)


def as_of(db: Database, syncer: Syncer) -> dict:
    c = db.conn
    checked = None if syncer.last_check is None else \
        datetime.fromtimestamp(syncer.last_check, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "newest_activity": c.execute("SELECT max(start_local) FROM activities WHERE visible = 1").fetchone()[0],
        "newest_wellness_day": c.execute("SELECT max(date) FROM daily_stats").fetchone()[0],
        "series_through": {r[0]: r[1] for r in c.execute(
            "SELECT channel, max(date) FROM daily_series GROUP BY channel ORDER BY channel")},
        "last_sync_check": checked,
        "sync": syncer.last_outcome,
    }
