"""The archive of originals: content-addressed blobs, export zips byte for
byte, and source records. Layout under the root:

    raw/<sha256>
    exports/<provider>/<YYYY-MM-DD>-<name>
    records/<provider>/<provider_activity_id>/<YYYYMMDDTHHMMSSZ>-<content_sha[:12]>.json
    wellness/<provider>/<source>/<key>/<YYYYMMDDTHHMMSSZ>-<content_sha[:12]>.json

Only the local-folder backend exists here; R2 arrives in Plan 3.
"""
import hashlib
import os
import shutil
import tempfile
from datetime import datetime, timezone
from typing import Protocol

from .records import SourceRecord, WellnessRecord, latest_wellness, recency

DEFAULT_URL = "file://data/archive"


class Archive(Protocol):
    def put_blob(self, data: bytes) -> str: ...
    def get_blob(self, sha256: str) -> bytes: ...
    def has_blob(self, sha256: str) -> bool: ...
    def put_export(self, provider: str, src_path: str, *, today: str) -> str: ...
    def put_record(self, rec: SourceRecord) -> bool: ...
    def list_records(self) -> list[SourceRecord]: ...
    def put_wellness(self, rec: WellnessRecord) -> bool: ...
    def list_wellness(self) -> list[WellnessRecord]: ...


def _safe(part: str) -> str:
    if not part or part in (".", "..") or "/" in part or os.sep in part:
        raise ValueError(f"unsafe archive key part: {part!r}")
    return part


def _stamp(fetched_at: str) -> str:
    dt = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _file_sha(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class LocalArchive:
    def __init__(self, root: str):
        self.root = root

    def _path(self, key: str) -> str:
        return os.path.join(self.root, *key.split("/"))

    def _write(self, key: str, write) -> None:
        """Write via a temp file + os.replace so an interrupted run never
        leaves a partial file under the final key."""
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                write(f)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def put_blob(self, data: bytes) -> str:
        sha = hashlib.sha256(data).hexdigest()
        if not self.has_blob(sha):
            self._write(f"raw/{sha}", lambda f: f.write(data))
        return sha

    def get_blob(self, sha256: str) -> bytes:
        try:
            with open(self._path(f"raw/{_safe(sha256)}"), "rb") as f:
                return f.read()
        except FileNotFoundError:
            raise KeyError(sha256) from None

    def has_blob(self, sha256: str) -> bool:
        return os.path.exists(self._path(f"raw/{_safe(sha256)}"))

    def put_export(self, provider: str, src_path: str, *, today: str) -> str:
        """Store the export byte for byte. An identical export already stored
        keeps its key, so re-importing it later writes no new records."""
        existing = self._same_export(provider, src_path)
        if existing:
            return existing
        key = f"exports/{_safe(provider)}/{today}-{os.path.basename(src_path)}"
        with open(src_path, "rb") as src:
            self._write(key, lambda f: shutil.copyfileobj(src, f))
        return key

    def _same_export(self, provider: str, src_path: str) -> str | None:
        d = self._path(f"exports/{_safe(provider)}")
        if not os.path.isdir(d):
            return None
        size, digest = os.path.getsize(src_path), None
        for name in sorted(os.listdir(d)):
            path = os.path.join(d, name)
            if name.startswith(".tmp-") or os.path.getsize(path) != size:
                continue
            digest = digest or _file_sha(src_path)
            if _file_sha(path) == digest:
                return f"exports/{provider}/{name}"
        return None

    def _record_dir(self, provider: str, pid: str) -> str:
        return f"records/{_safe(provider)}/{_safe(pid)}"

    def put_record(self, rec: SourceRecord) -> bool:
        d = self._record_dir(rec.provider, rec.provider_activity_id)
        stored = self._read_records(self._path(d))
        if stored:
            newest = max(stored, key=recency)
            if newest.content_sha() == rec.content_sha():
                return False
        data = rec.to_json()
        self._write(f"{d}/{_stamp(rec.fetched_at)}-{rec.content_sha()[:12]}.json",
                    lambda f: f.write(data))
        return True

    @staticmethod
    def _read_records(path: str, cls=SourceRecord) -> list:
        if not os.path.isdir(path):
            return []
        out = []
        for name in sorted(os.listdir(path)):
            if name.endswith(".json") and not name.startswith(".tmp-"):
                with open(os.path.join(path, name), "rb") as f:
                    out.append(cls.from_json(f.read()))
        return out

    def list_records(self) -> list[SourceRecord]:
        base = self._path("records")
        if not os.path.isdir(base):
            return []
        out = []
        for provider in sorted(os.listdir(base)):
            for pid in sorted(os.listdir(os.path.join(base, provider))):
                out.extend(self._read_records(os.path.join(base, provider, pid)))
        return out

    def put_wellness(self, rec: WellnessRecord) -> bool:
        d = f"wellness/{_safe(rec.provider)}/{_safe(rec.source)}/{_safe(rec.key)}"
        stored = self._read_records(self._path(d), WellnessRecord)
        if stored and latest_wellness(stored)[0].content_sha() == rec.content_sha():
            return False
        data = rec.to_json()
        self._write(f"{d}/{_stamp(rec.fetched_at)}-{rec.content_sha()[:12]}.json",
                    lambda f: f.write(data))
        return True

    def list_wellness(self) -> list[WellnessRecord]:
        base = self._path("wellness")
        if not os.path.isdir(base):
            return []
        out = []
        for provider in sorted(os.listdir(base)):
            for source in sorted(os.listdir(os.path.join(base, provider))):
                for key in sorted(os.listdir(os.path.join(base, provider, source))):
                    out.extend(self._read_records(os.path.join(base, provider, source, key), WellnessRecord))
        return out


def open_archive(url: str | None = None) -> Archive:
    """url → env ARCHIVE_URL → file://data/archive. Only file:// for now."""
    url = url or os.environ.get("ARCHIVE_URL") or DEFAULT_URL
    if not url.startswith("file://"):
        raise ValueError(f"unsupported archive URL: {url} (only file:// until Plan 3)")
    return LocalArchive(url[len("file://"):])
