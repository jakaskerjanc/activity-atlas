"""Keep the local database in step with the master in R2, and say how current it is.

R2's etag for the database (uploaded with a single put) is the MD5 of the file,
so comparing it with the local file's MD5 tells whether anything changed
without downloading the whole file.

The check and the download run on a background thread (``start``), so a tool
call never waits for a download: tools answer from the local copy as it is, and
the first call after the new file is in place reopens it
(``Database.changed_on_disk``). A call may wait briefly for the quick check
(``wait_checked``), so its ``notice`` can say whether the copy is out of date.
"""
import hashlib
import os
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone

from ingest import writer
from ingest.objstore import ObjectStore

from .database import Database

SYNC_INTERVAL_S = 3600
STOP_WAIT_S = 2.0
# The server's own downloads are named <db>.mcp-pull-XXXX. A running one writes at least
# every read timeout (30 s) or fails, so one untouched for this long was abandoned by a
# server that was killed.
DOWNLOAD_TAG = "mcp-pull"
ABANDONED_AFTER_S = 600
OFF = "off (--no-sync)"


class _Stopped(Exception):
    """The server is shutting down: abandon the download."""


def _md5(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _mb(n: int) -> str:
    return f"{n / 1_000_000:.0f}"


class Syncer:
    def __init__(self, db_path: str, store: ObjectStore | None, interval_s: float = SYNC_INTERVAL_S,
                 clock: Callable[[], float] = time.time, off: bool = False):
        self.db_path = db_path
        self.store = None if off else store
        self.off = off  # --no-sync: never contact R2
        self.interval_s = interval_s
        self.clock = clock
        self.last_check: float | None = None
        self.last_outcome = "not checked yet"
        self.progress = "starting"  # of the download under way, e.g. "27 of 46 MB"
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._checked = threading.Event()  # set while no check is deciding what to do
        self._checked.set()

    def _due(self, force: bool) -> bool:
        return force or self.last_check is None or self.clock() - self.last_check >= self.interval_s

    def maybe_sync(self, force: bool = False) -> bool:
        """Check R2 now, on this thread (at most once per interval unless forced); True when
        a newer database was downloaded and installed over the local file."""
        with self._lock:
            if not self._due(force):
                return False
            self.last_check = self.clock()
        return self._sync()

    def start(self, force: bool = False) -> bool:
        """Check R2 on a background thread when a check is due (or forced) and none is running.
        Never waits. True when a check is running after the call."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return True
            if not self._due(force):
                return False
            self.last_check = self.clock()
            if self.store is None:  # nothing to check, no thread needed
                self.last_outcome = OFF if self.off else "no R2"
                return False
            self.last_outcome = "checking"
            self._checked.clear()
            self._thread = threading.Thread(target=self._sync, name="r2-sync", daemon=True)
            self._thread.start()
            return True

    def wait(self, timeout: float) -> bool:
        """Wait up to timeout seconds for a running check; True when none is running any more."""
        t = self._thread
        if t is not None:
            t.join(timeout)
        return t is None or not t.is_alive()

    def remove_abandoned_downloads(self) -> list[str]:
        """Delete this server's partial downloads that nobody has written to for
        ABANDONED_AFTER_S (left by a server that was killed); other processes'
        working copies are never touched. Returns the paths removed."""
        directory = os.path.dirname(os.path.abspath(self.db_path))
        prefix = f"{os.path.basename(self.db_path)}.{DOWNLOAD_TAG}-"
        removed = []
        try:
            names = os.listdir(directory)
        except FileNotFoundError:
            return removed
        for name in names:
            path = os.path.join(directory, name)
            try:
                if name.startswith(prefix) and self.clock() - os.stat(path).st_mtime > ABANDONED_AFTER_S:
                    os.remove(path)
                    removed.append(path)
            except FileNotFoundError:
                pass  # removed meanwhile
        return removed

    def wait_checked(self, timeout: float) -> None:
        """Wait up to timeout seconds until a running check knows whether the local copy is
        current (it is, or a download has started); does not wait for the download."""
        self._checked.wait(timeout)

    def stop(self) -> None:
        """Abandon a running download (at the next chunk) and remove its temporary file."""
        self._stop.set()
        self.wait(STOP_WAIT_S)

    def _progress(self, done: int, total: int | None) -> None:
        self._checked.set()
        if self._stop.is_set():
            raise _Stopped()
        size = f" of {_mb(total)}" if total else ""
        self.progress = f"{_mb(done)}{size} MB"
        self.last_outcome = f"downloading a newer database ({self.progress})"

    def _sync(self) -> bool:
        tmp = None
        try:
            if self.store is None:
                self.last_outcome = OFF if self.off else "no R2"
                return False
            head = self.store.head(writer.DB_KEY)
            if head is None:
                self.last_outcome = "no database in R2"
                return False
            if head["etag"].strip('"') == _md5(self.db_path):
                self.last_outcome = "up to date"
                return False
            tmp = writer.working_copy(self.db_path, DOWNLOAD_TAG)
            self._progress(0, head.get("size"))
            try:
                self.store.download(writer.DB_KEY, tmp, progress=self._progress)
            except KeyError:
                self.last_outcome = "no database in R2"
                return False
            writer.install(tmp, self.db_path)  # a rename: readers see the old file or the new one
            tmp = None
            self.last_outcome = "downloaded"
            return True
        except _Stopped:
            self.last_outcome = "stopped"
            return False
        except Exception as exc:  # network, credentials, a stalled read: answer from the local copy
            self.last_outcome = f"failed: {exc}"
            return False
        finally:
            self._checked.set()
            if tmp and os.path.exists(tmp):
                os.remove(tmp)


def notice(db: Database | None, syncer: Syncer) -> str | None:
    """One line for the user when the answer may come from an out-of-date copy; None when it does not."""
    sync = syncer.last_outcome
    if db is None:
        if sync.startswith(("downloading", "checking")):
            return (f"There is no local database yet: it is being downloaded from R2 ({syncer.progress}). "
                    "Try again in a minute.")
        return f"There is no local database, and it could not be downloaded ({sync}). Call sync to try again."
    if sync.startswith("downloading"):
        return (f"The local database is out of date: a newer one is downloading from R2 ({syncer.progress}). "
                "This answer is from the older copy.")
    if db.changed_on_disk():
        return "A newer database arrived during this call: this answer is from the older copy; the next call reads it."
    if sync == "checking":
        return "Still checking R2 for a newer database: this answer may be from an out-of-date copy."
    if sync.startswith("failed"):
        return (f"Could not check R2 for a newer database ({sync}): this answer is from the local copy, "
                "which may be out of date.")
    return None


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
