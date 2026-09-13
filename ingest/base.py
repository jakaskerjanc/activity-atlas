import gzip
from abc import ABC, abstractmethod

from . import store, normalize, dedupe


class Ingestor(ABC):
    """Shared engine: pull RawActivity items, normalize, reconcile into the store.
    Every import/fetch component runs through this, so all are idempotent."""
    source: str = ""

    def __init__(self, db_path, simplify_tol_m: float = 0.5):
        self.db_path = db_path
        self.tol = simplify_tol_m

    @abstractmethod
    def activities(self):
        """Yield RawActivity items."""

    def run(self) -> dict:
        conn = store.connect(self.db_path)
        store.init_schema(conn)
        counts = {"insert": 0, "update": 0, "merge": 0}
        for raw in self.activities():
            counts[dedupe.reconcile(conn, normalize.normalize(raw, self.tol))] += 1
        conn.commit()
        conn.close()
        return counts


class BaseImporter(Ingestor):
    """Bulk import from local export files."""

    def open_activity_file(self, path):
        """Return (name_without_gz, binary_fileobj), transparently gunzipping."""
        if path.endswith(".gz"):
            return path[:-3], gzip.open(path, "rb")
        return path, open(path, "rb")

    def parse_file(self, name: str, fileobj):
        from .parse.fit import parse_fit
        from .parse.tcx import parse_tcx
        from .parse.gpx import parse_gpx
        low = name.lower()
        if low.endswith(".fit"):
            return parse_fit(fileobj)
        if low.endswith(".tcx"):
            return parse_tcx(fileobj)
        if low.endswith(".gpx"):
            return parse_gpx(fileobj)
        raise ValueError(f"unsupported activity file: {name}")


class BaseFetcher(Ingestor):
    """Live API fetch. Deferred phase — subclasses implement activities();
    high_water() supports incremental windowing off the store."""

    def high_water(self, conn):
        row = conn.execute("SELECT MAX(start_time) AS m FROM activities").fetchone()
        return row["m"] if row and row["m"] else None
