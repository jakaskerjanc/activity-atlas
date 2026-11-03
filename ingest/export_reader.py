"""Shared by the export importers: read an export zip or folder by member
path, and archive the zip byte for byte."""
import os
import warnings
import zipfile
from datetime import datetime, timezone

from .archive import Archive


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _member_time(date_time: tuple) -> datetime | None:
    """A member's DOS timestamp as UTC; None when it is zip's "no date"
    (1980-01-01 00:00:00) or not a real date (e.g. a zeroed field)."""
    if date_time == (1980, 1, 1, 0, 0, 0):
        return None
    try:
        return datetime(*date_time, tzinfo=timezone.utc)
    except ValueError:
        return None


def export_made_at(path: str) -> str | None:
    """When an export zip was made: its newest member time, read as UTC.
    None for a folder, or a zip that carries no usable dates."""
    if not os.path.isfile(path):
        return None
    with zipfile.ZipFile(path) as zf:
        times = [t for i in zf.infolist() if (t := _member_time(i.date_time))]
    return max(times).isoformat() if times else None


def newest_export_as_of(archive: Archive, provider: str) -> str | None:
    """The latest as_of among the provider's archived export records."""
    kind = f"{provider}_export"
    stamps = [r.as_of for r in archive.list_records()
              if r.provider == provider and r.origin.get("kind") == kind and r.as_of]
    return max(stamps, default=None)


def is_older_export(provider: str, made: str | None, newest: str | None) -> bool:
    """True (with a warning) when this export predates one already imported."""
    if not (made and newest and made < newest):
        return False
    warnings.warn(f"{provider} export made {made} is older than an export already imported ({newest}): "
                  "its records are archived but do not replace newer ones, and it marks nothing deleted")
    return True


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
