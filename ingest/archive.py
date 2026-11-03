"""The archive of originals: content-addressed blobs, export zips byte for
byte, and source records. Layout under the root:

    raw/<sha256>
    exports/<provider>/<YYYY-MM-DD>-<name>
    records/<provider>/<provider_activity_id>/<YYYYMMDDTHHMMSSZ>-<content_sha[:12]>.json
    wellness/<provider>/<source>/<key>/<YYYYMMDDTHHMMSSZ>-<content_sha[:12]>.json

Two backends share that layout: a plain folder (LocalArchive) and a private R2
bucket fronted by a local cache folder (RemoteArchive).
"""
import hashlib
import io
import os
import shutil
import tempfile
from datetime import datetime, timezone
from typing import Protocol

from .objstore import ObjectStore, store_from_env
from .records import SourceRecord, WellnessRecord, latest_wellness, recency

DEFAULT_URL = "file://data/archive"
DEFAULT_CACHE = "data/cache"


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


def _free_export_key(prefix: str, today: str, filename: str, taken) -> str:
    """``<prefix><today>-<name>``, or ``<today>-<stem>-2<ext>``, ``-3``, ... when
    that key holds a different export (Strava names every export export_<id>.zip)."""
    stem, ext = os.path.splitext(filename)
    key, n = f"{prefix}{today}-{filename}", 1
    while taken(key):
        n += 1
        key = f"{prefix}{today}-{stem}-{n}{ext}"
    return key


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
        keeps its key, so re-importing it later writes no new records. A different
        export that would get an existing key gets the next free ``-2``, ``-3`` name."""
        existing = self._same_export(provider, src_path)
        if existing:
            return existing
        key = _free_export_key(f"exports/{_safe(provider)}/", today, os.path.basename(src_path),
                               lambda k: os.path.exists(self._path(k)))
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

    @staticmethod
    def _wellness_dir(rec: WellnessRecord) -> str:
        return f"wellness/{_safe(rec.provider)}/{_safe(rec.source)}/{_safe(rec.key)}"

    def put_wellness(self, rec: WellnessRecord) -> bool:
        d = self._wellness_dir(rec)
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


class RemoteArchive(LocalArchive):
    """The archive in an object store (R2), with ``cache_root`` as a read cache.

    Every write goes to the store first and the cache second, so the cache never
    holds a key the store lacks. Records are immutable (timestamp + content hash
    in the key), so a cached key is never refetched. Exports are never cached.
    """

    def __init__(self, store: ObjectStore, cache_root: str):
        super().__init__(cache_root)
        self.store = store

    def _write(self, key: str, write) -> None:
        buf = io.BytesIO()
        write(buf)
        data = buf.getvalue()
        self.store.put(key, data)
        super()._write(key, lambda f: f.write(data))

    def _fetch(self, key: str, sha256: str | None = None) -> bytes:
        """Download key into the cache only (it is already in the store). With
        ``sha256``, the bytes must hash to it before anything is cached."""
        data, _ = self.store.get(key)
        if sha256 is not None and hashlib.sha256(data).hexdigest() != sha256:
            raise ValueError(f"archive blob {key} does not match its hash")
        super()._write(key, lambda f: f.write(data))
        return data

    def has_blob(self, sha256: str) -> bool:
        return super().has_blob(sha256) or self.store.head(f"raw/{sha256}") is not None

    def get_blob(self, sha256: str) -> bytes:
        try:
            return super().get_blob(sha256)
        except KeyError:
            pass
        try:
            return self._fetch(f"raw/{_safe(sha256)}", sha256)
        except KeyError:
            raise KeyError(sha256) from None

    def _sync(self, prefix: str) -> None:
        keys = [key for key, _ in self.store.list(prefix)]
        for key in keys:  # the store is untrusted: no key may escape the cache root
            try:
                if not key.startswith(prefix):
                    raise ValueError(key)
                for part in key.split("/"):
                    _safe(part)
            except ValueError:
                raise ValueError(f"unsafe archive key from store: {key!r}") from None
        for key in keys:
            if not os.path.exists(self._path(key)):
                self._fetch(key)

    def put_record(self, rec: SourceRecord) -> bool:
        self._sync(self._record_dir(rec.provider, rec.provider_activity_id) + "/")
        return super().put_record(rec)

    def list_records(self) -> list[SourceRecord]:
        self._sync("records/")
        return super().list_records()

    def put_wellness(self, rec: WellnessRecord) -> bool:
        self._sync(self._wellness_dir(rec) + "/")
        return super().put_wellness(rec)

    def list_wellness(self) -> list[WellnessRecord]:
        self._sync("wellness/")
        return super().list_wellness()

    def put_export(self, provider: str, src_path: str, *, today: str) -> str:
        prefix = f"exports/{_safe(provider)}/"
        size, sha = os.path.getsize(src_path), None
        taken = set()
        for key, key_size in self.store.list(prefix):
            taken.add(key)
            if key_size != size:
                continue
            sha = sha or _file_sha(src_path)
            head = self.store.head(key)
            if head and head["metadata"].get("sha256") == sha:
                return key
        key = _free_export_key(prefix, today, os.path.basename(src_path), taken.__contains__)
        self.store.put_file(key, src_path, metadata={"sha256": sha or _file_sha(src_path)})
        return key


def is_remote(a: Archive) -> bool:
    return isinstance(a, RemoteArchive)


def open_archive(url: str | None = None) -> Archive:
    """url → env ARCHIVE_URL → r2://$R2_BUCKET when R2 credentials are set →
    file://data/archive."""
    url = url or os.environ.get("ARCHIVE_URL")
    if not url:
        store = store_from_env()
        url = f"r2://{store.bucket}" if store else DEFAULT_URL
    if url.startswith("file://"):
        return LocalArchive(url[len("file://"):])
    if url.startswith("r2://"):
        store = store_from_env()
        if store is None:
            raise ValueError(f"{url}: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set")
        if url[len("r2://"):] != store.bucket:
            raise ValueError(f"{url}: bucket differs from R2_BUCKET={store.bucket}")
        # One cache folder per bucket, so a cached key is never taken for one the bucket lacks.
        return RemoteArchive(store, os.path.join(DEFAULT_CACHE, store.bucket))
    raise ValueError(f"unsupported archive URL: {url} (expected file:// or r2://)")
