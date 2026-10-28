"""Shared by the export importers: read an export zip or folder by member
path, and archive the zip byte for byte."""
import os
import warnings
import zipfile
from datetime import datetime, timezone

from .archive import Archive


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class ExportReader:
    """Read-only view of an export zip or folder, by '/'-separated member path."""

    def __init__(self, path: str):
        self.path = path
        self.is_zip = os.path.isfile(path)
        if self.is_zip:
            self._zf = zipfile.ZipFile(path)
            self.names = [n for n in self._zf.namelist() if not n.endswith("/")]
        else:
            self.names = sorted(
                os.path.relpath(os.path.join(d, f), path).replace(os.sep, "/")
                for d, _, files in os.walk(path) for f in files)

    def read(self, name: str) -> bytes:
        if self.is_zip:
            return self._zf.read(name)
        with open(os.path.join(self.path, *name.split("/")), "rb") as f:
            return f.read()

    def find(self, suffix: str) -> str | None:
        """The shortest member path ending in `suffix` (on a path boundary)."""
        suffix = suffix.strip().lstrip("/")
        hits = [n for n in self.names if n == suffix or n.endswith("/" + suffix)]
        return min(hits, key=lambda n: (len(n), n)) if hits else None

    def close(self):
        if self.is_zip:
            self._zf.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def archive_export(archive: Archive, provider: str, path: str, today: str) -> str | None:
    """Store the export zip; a folder only warns."""
    if os.path.isfile(path):
        return archive.put_export(provider, path, today=today)
    warnings.warn("directory input: no export archive stored")
    return None
