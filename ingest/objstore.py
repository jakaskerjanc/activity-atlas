"""Object store behind the archive and the database: a small protocol with an
in-memory implementation for tests and an S3Store for Cloudflare R2.

R2 supports conditional writes (``If-Match`` / ``If-None-Match``), which the
database lock and the archive's write-once keys rely on. A failed condition
raises ``PreconditionFailed`` on every implementation.

boto3 is imported lazily, when an S3Store builds its own client, so this
module (and MemoryStore) works without it installed.
"""
import hashlib
from typing import Protocol

_CONFLICT_CODES = {"PreconditionFailed", "ConditionalRequestConflict"}
_CONFLICT_STATUSES = {409, 412}
_MISSING_CODES = {"404", "NoSuchKey", "NotFound"}


class PreconditionFailed(Exception):
    """A conditional write was refused: the key's etag did not match."""


class ObjectStore(Protocol):
    def get(self, key: str) -> tuple[bytes, str]: ...
    def head(self, key: str) -> dict | None: ...
    def put(
        self, key: str, data: bytes, *,
        if_match: str | None = None, if_none_match: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> str: ...
    def put_file(self, key: str, path: str, *, metadata: dict[str, str] | None = None) -> None: ...
    def list(self, prefix: str) -> list[tuple[str, int]]: ...
    def delete(self, key: str) -> None: ...


class MemoryStore:
    """Dict-backed ObjectStore with S3-like etags and conditional writes."""

    def __init__(self) -> None:
        self._objects: dict[str, tuple[bytes, str, dict[str, str]]] = {}

    def get(self, key: str) -> tuple[bytes, str]:
        data, etag, _ = self._objects[key]
        return data, etag

    def head(self, key: str) -> dict | None:
        if key not in self._objects:
            return None
        data, etag, metadata = self._objects[key]
        return {"size": len(data), "etag": etag, "metadata": dict(metadata)}

    def put(
        self, key: str, data: bytes, *,
        if_match: str | None = None, if_none_match: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> str:
        current = self._objects.get(key)
        if if_none_match == "*" and current is not None:
            raise PreconditionFailed(f"{key} already exists")
        if if_match is not None and (current is None or current[1] != if_match):
            raise PreconditionFailed(f"{key} etag does not match {if_match}")
        etag = '"' + hashlib.md5(data).hexdigest() + '"'
        self._objects[key] = (data, etag, dict(metadata or {}))
        return etag

    def put_file(self, key: str, path: str, *, metadata: dict[str, str] | None = None) -> None:
        with open(path, "rb") as fh:
            self.put(key, fh.read(), metadata=metadata)

    def list(self, prefix: str) -> list[tuple[str, int]]:
        return sorted((k, len(v[0])) for k, v in self._objects.items() if k.startswith(prefix))

    def delete(self, key: str) -> None:
        self._objects.pop(key, None)


def _error_code(exc) -> str:
    return exc.response.get("Error", {}).get("Code", "")


def _http_status(exc) -> int | None:
    return exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


class S3Store:
    """ObjectStore over an S3-compatible bucket (Cloudflare R2)."""

    def __init__(
        self, bucket: str, *, account_id: str, access_key_id: str, secret_access_key: str, client=None,
    ) -> None:
        self.bucket = bucket
        self.endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "s3",
                endpoint_url=self.endpoint,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                config=Config(
                    region_name="auto",
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                    retries={"max_attempts": 5, "mode": "standard"},
                ),
            )
        self._client = client

    def get(self, key: str) -> tuple[bytes, str]:
        from botocore.exceptions import ClientError

        try:
            response = self._client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if _error_code(exc) in _MISSING_CODES or _http_status(exc) == 404:
                raise KeyError(key) from exc
            raise
        return response["Body"].read(), response["ETag"]

    def head(self, key: str) -> dict | None:
        from botocore.exceptions import ClientError

        try:
            response = self._client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if _error_code(exc) in _MISSING_CODES or _http_status(exc) == 404:
                return None
            raise
        return {
            "size": response["ContentLength"],
            "etag": response["ETag"],
            "metadata": dict(response.get("Metadata", {})),
        }

    def put(
        self, key: str, data: bytes, *,
        if_match: str | None = None, if_none_match: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> str:
        from botocore.exceptions import ClientError

        params: dict = {"Bucket": self.bucket, "Key": key, "Body": data}
        if if_match is not None:
            params["IfMatch"] = if_match
        if if_none_match is not None:
            params["IfNoneMatch"] = if_none_match
        if metadata:
            params["Metadata"] = metadata
        try:
            return self._client.put_object(**params)["ETag"]
        except ClientError as exc:
            if _error_code(exc) in _CONFLICT_CODES or _http_status(exc) in _CONFLICT_STATUSES:
                raise PreconditionFailed(f"{key}: {_error_code(exc) or _http_status(exc)}") from exc
            raise

    def put_file(self, key: str, path: str, *, metadata: dict[str, str] | None = None) -> None:
        extra = {"Metadata": metadata} if metadata else None
        self._client.upload_file(path, self.bucket, key, ExtraArgs=extra)

    def list(self, prefix: str) -> list[tuple[str, int]]:
        found: list[tuple[str, int]] = []
        token = None
        while True:
            params = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                params["ContinuationToken"] = token
            page = self._client.list_objects_v2(**params)
            found.extend((obj["Key"], obj["Size"]) for obj in page.get("Contents", []))
            if not page.get("IsTruncated"):
                return sorted(found)
            token = page["NextContinuationToken"]

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=key)


def store_from_env(*, read_only: bool = False) -> S3Store | None:
    """An S3Store from R2_* settings (process env or repo-root .env); None when incomplete."""
    from . import config

    prefix = "R2_RO_" if read_only else "R2_"
    account_id = config.env("R2_ACCOUNT_ID")
    bucket = config.env("R2_BUCKET")
    access_key_id = config.env(prefix + "ACCESS_KEY_ID")
    secret_access_key = config.env(prefix + "SECRET_ACCESS_KEY")
    if not (account_id and bucket and access_key_id and secret_access_key):
        return None
    return S3Store(
        bucket, account_id=account_id, access_key_id=access_key_id, secret_access_key=secret_access_key,
    )
