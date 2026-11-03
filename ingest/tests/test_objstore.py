import io
from unittest.mock import ANY

import boto3
import pytest
from botocore.stub import Stubber

from ingest import config, objstore
from ingest.objstore import MemoryStore, PreconditionFailed, S3Store


def test_memory_put_get_roundtrip():
    store = MemoryStore()
    etag = store.put("a", b"x")
    assert store.get("a") == (b"x", etag)
    assert etag == '"9dd4e461268c8034f5c8564e155c67a6"'
    with pytest.raises(KeyError):
        store.get("missing")


def test_memory_if_none_match_star():
    store = MemoryStore()
    store.put("a", b"x", if_none_match="*")
    with pytest.raises(PreconditionFailed):
        store.put("a", b"y", if_none_match="*")
    assert store.get("a")[0] == b"x"


def test_memory_if_match():
    store = MemoryStore()
    old = store.put("a", b"x")
    new = store.put("a", b"y", if_match=old)
    assert new != old
    with pytest.raises(PreconditionFailed):
        store.put("a", b"z", if_match=old)
    assert store.get("a") == (b"y", new)
    with pytest.raises(PreconditionFailed):
        store.put("absent", b"", if_match='"x"')
    assert store.head("absent") is None


def test_memory_list_and_head(tmp_path):
    store = MemoryStore()
    store.put("raw/b", b"22")
    store.put("raw/a", b"1")
    store.put("exports/z", b"333", metadata={"k": "v"})
    assert store.list("raw/") == [("raw/a", 1), ("raw/b", 2)]
    assert store.head("exports/z") == {"size": 3, "etag": ANY, "metadata": {"k": "v"}}
    assert store.head("missing") is None
    path = tmp_path / "f"
    path.write_bytes(b"4444")
    store.put_file("exports/f", str(path), metadata={"m": "n"})
    assert store.get("exports/f")[0] == b"4444"
    assert store.head("exports/f")["metadata"] == {"m": "n"}
    store.delete("exports/f")
    store.delete("exports/f")  # deleting an absent key is not an error
    assert store.head("exports/f") is None


def _s3():
    client = boto3.client(
        "s3", region_name="auto", endpoint_url="https://acc.r2.cloudflarestorage.com",
        aws_access_key_id="k", aws_secret_access_key="s",
    )
    return S3Store("b", account_id="acc", access_key_id="k", secret_access_key="s", client=client), client


@pytest.mark.parametrize("code,status", [("PreconditionFailed", 412), ("ConditionalRequestConflict", 409)])
def test_s3store_maps_if_match_and_412(code, status):
    store, client = _s3()
    with Stubber(client) as stub:
        stub.add_client_error(
            "put_object", service_error_code=code, http_status_code=status,
            expected_params={"Bucket": "b", "Key": "db/activities.sqlite", "Body": ANY, "IfMatch": '"e1"'},
        )
        with pytest.raises(PreconditionFailed):
            store.put("db/activities.sqlite", b"data", if_match='"e1"')
        stub.assert_no_pending_responses()


def test_s3store_put_returns_etag_and_sends_conditions():
    store, client = _s3()
    with Stubber(client) as stub:
        stub.add_response(
            "put_object", {"ETag": '"abc"'},
            {"Bucket": "b", "Key": "k", "Body": ANY, "IfNoneMatch": "*", "Metadata": {"m": "n"}},
        )
        assert store.put("k", b"d", if_none_match="*", metadata={"m": "n"}) == '"abc"'


def test_s3store_get_missing_is_keyerror_and_returns_etag():
    store, client = _s3()
    with Stubber(client) as stub:
        stub.add_client_error("get_object", service_error_code="NoSuchKey", http_status_code=404)
        with pytest.raises(KeyError):
            store.get("missing")
        stub.add_response("get_object", {"Body": _body(b"hello"), "ETag": '"e"'}, {"Bucket": "b", "Key": "k"})
        assert store.get("k") == (b"hello", '"e"')


def _body(data):
    from botocore.response import StreamingBody
    return StreamingBody(io.BytesIO(data), len(data))


def test_s3store_head_404_is_none():
    store, client = _s3()
    with Stubber(client) as stub:
        stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
        assert store.head("missing") is None
        stub.add_response(
            "head_object", {"ContentLength": 5, "ETag": '"e"', "Metadata": {"m": "n"}}, {"Bucket": "b", "Key": "k"}
        )
        assert store.head("k") == {"size": 5, "etag": '"e"', "metadata": {"m": "n"}}


def test_s3store_list_pages_and_sorts():
    store, client = _s3()
    with Stubber(client) as stub:
        stub.add_response(
            "list_objects_v2",
            {"IsTruncated": True, "NextContinuationToken": "t", "Contents": [{"Key": "p/b", "Size": 2}]},
            {"Bucket": "b", "Prefix": "p/"},
        )
        stub.add_response(
            "list_objects_v2",
            {"IsTruncated": False, "Contents": [{"Key": "p/a", "Size": 1}]},
            {"Bucket": "b", "Prefix": "p/", "ContinuationToken": "t"},
        )
        assert store.list("p/") == [("p/a", 1), ("p/b", 2)]


def test_s3store_delete():
    store, client = _s3()
    with Stubber(client) as stub:
        stub.add_response("delete_object", {}, {"Bucket": "b", "Key": "k"})
        store.delete("k")
        stub.assert_no_pending_responses()


def test_s3store_builds_r2_client_config():
    store = S3Store("b", account_id="acc", access_key_id="k", secret_access_key="s")
    assert store.endpoint == "https://acc.r2.cloudflarestorage.com"
    cfg = store._client.meta.config
    assert cfg.region_name == "auto"
    assert cfg.request_checksum_calculation == "when_required"
    assert cfg.response_checksum_validation == "when_required"
    assert cfg.retries["mode"] == "standard"
    assert cfg.retries["total_max_attempts"] == 6  # botocore normalises max_attempts=5 retries


R2_NAMES = (
    "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
    "R2_RO_ACCESS_KEY_ID", "R2_RO_SECRET_ACCESS_KEY",
)


def test_store_from_env_needs_bucket_and_keys(monkeypatch, tmp_path):
    for name in R2_NAMES:
        monkeypatch.delenv(name, raising=False)
    dotenv = tmp_path / ".env"
    dotenv.write_text("")
    monkeypatch.setattr(config, "DOTENV_FILE", str(dotenv))
    assert objstore.store_from_env() is None

    monkeypatch.setenv("R2_ACCOUNT_ID", "acc")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "rw-id")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "rw-secret")
    assert objstore.store_from_env() is None  # no bucket
    monkeypatch.setenv("R2_BUCKET", "bkt")
    store = objstore.store_from_env()
    assert isinstance(store, S3Store)
    assert store.bucket == "bkt"
    assert store.endpoint == "https://acc.r2.cloudflarestorage.com"
    assert store._client._request_signer._credentials.access_key == "rw-id"

    assert objstore.store_from_env(read_only=True) is None  # no RO pair yet
    monkeypatch.setenv("R2_RO_ACCESS_KEY_ID", "ro-id")
    monkeypatch.setenv("R2_RO_SECRET_ACCESS_KEY", "ro-secret")
    ro = objstore.store_from_env(read_only=True)
    assert ro._client._request_signer._credentials.access_key == "ro-id"


def test_store_from_env_reads_dotenv(monkeypatch, tmp_path):
    for name in R2_NAMES:
        monkeypatch.delenv(name, raising=False)
    dotenv = tmp_path / ".env"
    dotenv.write_text("R2_ACCOUNT_ID=acc\nR2_ACCESS_KEY_ID=i\nR2_SECRET_ACCESS_KEY=s\nR2_BUCKET=bkt\n")
    monkeypatch.setattr(config, "DOTENV_FILE", str(dotenv))
    assert objstore.store_from_env().bucket == "bkt"
