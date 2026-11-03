"""Opt-in check of R2's real conditional-write semantics and the checksum
config: ``R2_LIVE_TEST=1 pytest ingest/tests/test_objstore_live.py`` with the
R2_* settings in the environment or .env. Never runs by default."""
import os
import uuid

import pytest

from ingest.objstore import PreconditionFailed, store_from_env

USES_LIVE_R2 = True  # tells the conftest not to clear R2_* settings
pytestmark = pytest.mark.skipif(os.environ.get("R2_LIVE_TEST") != "1", reason="live R2 test")


def test_live_conditional_writes_head_and_list(tmp_path):
    store = store_from_env()
    assert store is not None, "R2_* settings are incomplete"
    prefix = f"test/{uuid.uuid4()}/"
    first, second, uploaded = prefix + "a", prefix + "b", prefix + "c"
    try:
        etag = store.put(first, b"one", metadata={"kind": "live"})
        assert store.get(first) == (b"one", etag)

        with pytest.raises(PreconditionFailed):
            store.put(first, b"two", if_none_match="*")
        with pytest.raises(PreconditionFailed):
            store.put(first, b"two", if_match='"stale"')
        # A PUT replaces the object's metadata, so the overwrite restates it.
        new_etag = store.put(first, b"three", if_match=etag, metadata={"kind": "live"})
        assert new_etag != etag

        store.put(second, b"x")
        assert store.head(first) == {"size": 5, "etag": new_etag, "metadata": {"kind": "live"}}

        src = tmp_path / "export.zip"
        src.write_bytes(b"zipdata")
        store.put_file(uploaded, str(src), metadata={"sha256": "abc"})
        assert store.head(uploaded)["metadata"] == {"sha256": "abc"}
        assert store.head(uploaded)["size"] == 7
        assert store.get(uploaded)[0] == b"zipdata"

        assert store.list(prefix) == [(first, 5), (second, 1), (uploaded, 7)]
    finally:
        for key, _ in store.list(prefix):
            store.delete(key)
