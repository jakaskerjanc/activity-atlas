import hashlib
import os

import pytest
from ingest.archive import DEFAULT_CACHE, LocalArchive, RemoteArchive, is_remote, open_archive
from ingest.objstore import MemoryStore
from ingest.records import SourceRecord, WellnessRecord, _canonical, latest


@pytest.fixture(params=["local", "remote"])
def archive(request, tmp_path):
    """Every Archive behaviour must hold for the folder and the R2-with-cache backend."""
    if request.param == "local":
        return LocalArchive(str(tmp_path / "a"))
    return RemoteArchive(MemoryStore(), str(tmp_path / "cache"))


def stored_keys(a, prefix):
    """Keys the backend holds under prefix: the folder itself, or the object store (not the cache)."""
    if is_remote(a):
        return [k for k, _ in a.store.list(prefix)]
    found = []
    for dirpath, _, names in os.walk(a._path(prefix.rstrip("/"))):
        found += [os.path.relpath(os.path.join(dirpath, n), a.root).replace(os.sep, "/") for n in names]
    return sorted(found)


def stored_bytes(a, key):
    if is_remote(a):
        return a.store.get(key)[0]
    with open(a._path(key), "rb") as f:
        return f.read()


def _rec(fetched_at="2026-10-27T10:00:00+00:00", name="Run", as_of=None):
    return SourceRecord("garmin", "900", fetched_at, {"activityName": name}, None, None, {"kind": "garmin_api"}, as_of)


def test_blobs_are_content_addressed_and_idempotent(archive):
    a = archive
    sha = a.put_blob(b"fit-bytes")
    assert a.put_blob(b"fit-bytes") == sha and a.get_blob(sha) == b"fit-bytes"
    assert a.has_blob(sha) and not a.has_blob("0" * 64)
    assert stored_keys(a, "raw/") == [f"raw/{sha}"]
    with pytest.raises(KeyError):
        a.get_blob("0" * 64)


def test_put_export_is_byte_identical(archive, tmp_path):
    src = tmp_path / "export_123.zip"; src.write_bytes(b"PK\x03\x04zip")
    key = archive.put_export("strava", str(src), today="2026-10-27")
    assert key == "exports/strava/2026-10-27-export_123.zip"
    assert stored_bytes(archive, key) == b"PK\x03\x04zip"


def test_put_record_skips_unchanged_but_keeps_a_b_a_edits(archive):
    a = archive
    assert a.put_record(_rec()) is True
    assert a.put_record(_rec("2026-10-28T10:00:00+00:00")) is False        # same content
    assert a.put_record(_rec("2026-10-29T10:00:00+00:00", "Renamed")) is True
    assert a.put_record(_rec("2026-10-30T10:00:00+00:00", "Run")) is True  # back to A is a change
    assert [r.summary["activityName"] for r in latest(a.list_records())] == ["Run"]


def test_record_json_round_trip():
    r = _rec()
    assert SourceRecord.from_json(r.to_json()) == r


def test_open_archive_defaults_and_rejects_unknown(monkeypatch, tmp_path):
    monkeypatch.setenv("ARCHIVE_URL", f"file://{tmp_path}")
    assert isinstance(open_archive(), LocalArchive)
    with pytest.raises(ValueError):
        open_archive("s3://x")


def test_put_export_reuses_key_for_identical_bytes(archive, tmp_path):
    src = tmp_path / "export_123.zip"; src.write_bytes(b"PK\x03\x04zip")
    a = archive
    first = a.put_export("strava", str(src), today="2026-10-27")
    assert a.put_export("strava", str(src), today="2026-10-28") == first
    src.write_bytes(b"PK\x03\x04zip2")
    assert a.put_export("strava", str(src), today="2026-10-28") == "exports/strava/2026-10-28-export_123.zip"


def test_latest_prefers_as_of_over_fetched_at():
    a = _rec("2026-10-27T10:00:00+00:00", "A", as_of="2026-10-01T00:00:00+00:00")
    b = _rec("2026-10-20T10:00:00+00:00", "B")
    assert latest([a, b]) == [b]


def test_record_without_as_of_keeps_plan1_hash():
    r = _rec()
    plan1 = {"provider": "garmin", "provider_activity_id": "900", "summary": {"activityName": "Run"},
             "file_sha256": None, "file_name": None, "origin": {"kind": "garmin_api"}}
    assert r.content_sha() == hashlib.sha256(_canonical(plan1)).hexdigest()
    assert b"as_of" not in r.to_json()
    loaded = SourceRecord.from_json(_canonical({**plan1, "fetched_at": "2026-10-27T10:00:00+00:00"}))
    assert loaded == r and loaded.as_of is None
    with_as_of = _rec(as_of="2026-10-01T00:00:00+00:00")
    assert SourceRecord.from_json(with_as_of.to_json()) == with_as_of
    assert with_as_of.content_sha() != r.content_sha()


def test_put_record_compares_with_newest_by_recency(archive):
    a = archive
    b = _rec("2026-10-20T10:00:00+00:00", "B")
    older = _rec("2026-10-28T10:00:00+00:00", "A", as_of="2026-10-01T00:00:00+00:00")
    assert a.put_record(b) is True
    assert a.put_record(older) is True
    assert latest(a.list_records()) == [b]


def _wrec(fetched_at="2026-10-27T10:00:00+00:00", blob="a" * 64):
    return WellnessRecord("garmin", "monitoring_fit", "a" * 64, fetched_at, blob, "1.fit",
                          {"kind": "garmin_export"})


def test_put_wellness_skips_identical_and_lists(archive):
    a = archive
    first = _wrec()
    assert a.put_wellness(first) is True
    assert a.put_wellness(_wrec("2026-10-28T10:00:00+00:00")) is False     # same content
    changed = _wrec("2026-10-29T10:00:00+00:00", blob="b" * 64)
    assert a.put_wellness(changed) is True
    assert sorted(a.list_wellness(), key=lambda r: r.fetched_at) == [first, changed]
    assert WellnessRecord.from_json(first.to_json()) == first
    base = f"wellness/garmin/monitoring_fit/{'a' * 64}"
    assert stored_keys(a, "wellness/") == [f"{base}/20261027T100000Z-{first.content_sha()[:12]}.json",
                                           f"{base}/20261029T100000Z-{changed.content_sha()[:12]}.json"]


def _pair(tmp_path):
    store = MemoryStore()
    return (RemoteArchive(store, str(tmp_path / "cache-a")), RemoteArchive(store, str(tmp_path / "cache-b")), store)


def test_remote_cold_cache_sees_other_writer(tmp_path):
    a, b, _ = _pair(tmp_path)
    src = tmp_path / "export_1.zip"; src.write_bytes(b"PK\x03\x04zip")
    sha = a.put_blob(b"fit-bytes")
    a.put_record(_rec())
    a.put_wellness(_wrec())
    key = a.put_export("strava", str(src), today="2026-10-27")

    assert b.has_blob(sha) and b.get_blob(sha) == b"fit-bytes"
    assert b.list_records() == a.list_records() == [_rec()]
    assert b.list_wellness() == a.list_wellness() == [_wrec()]
    assert b.put_export("strava", str(src), today="2026-11-01") == key


def test_remote_get_blob_missing_raises_key_error(tmp_path):
    a, _, _ = _pair(tmp_path)
    with pytest.raises(KeyError):
        a.get_blob("0" * 64)


def test_remote_put_record_dedupes_against_store_not_cache(tmp_path):
    a, b, store = _pair(tmp_path)
    assert a.put_record(_rec()) is True
    assert a.put_wellness(_wrec()) is True
    records, wellness = store.list("records/"), store.list("wellness/")
    assert b.put_record(_rec("2026-10-28T10:00:00+00:00")) is False
    assert b.put_wellness(_wrec("2026-10-28T10:00:00+00:00")) is False
    assert store.list("records/") == records and store.list("wellness/") == wellness


def test_remote_failed_upload_leaves_cache_clean(tmp_path, monkeypatch):
    store, cache = MemoryStore(), tmp_path / "cache"
    real_put, calls = store.put, []

    def flaky_put(*args, **kwargs):
        calls.append(args[0])
        if len(calls) == 2:
            raise OSError("upload failed")
        return real_put(*args, **kwargs)

    monkeypatch.setattr(store, "put", flaky_put)
    a = RemoteArchive(store, str(cache))
    sha1 = a.put_blob(b"1")
    with pytest.raises(OSError):
        a.put_blob(b"2")
    cached = [os.path.relpath(os.path.join(d, n), cache) for d, _, names in os.walk(cache) for n in names]
    assert cached == [os.path.join("raw", sha1)]

    sha2 = hashlib.sha256(b"2").hexdigest()
    fresh_store = MemoryStore()
    fresh = RemoteArchive(fresh_store, str(cache))
    assert fresh.put_blob(b"2") == sha2
    assert [k for k, _ in fresh_store.list("raw/")] == [f"raw/{sha2}"]


def test_remote_export_same_size_compares_sha_metadata(tmp_path):
    a, _, store = _pair(tmp_path)
    one, two = tmp_path / "one.zip", tmp_path / "two.zip"
    one.write_bytes(b"AAAA"); two.write_bytes(b"BBBB")
    k1 = a.put_export("strava", str(one), today="2026-10-27")
    k2 = a.put_export("strava", str(two), today="2026-10-27")
    assert k1 != k2
    assert a.put_export("strava", str(one), today="2026-10-28") == k1
    assert [k for k, _ in store.list("exports/strava/")] == [k1, k2]
    assert store.head(k1)["metadata"]["sha256"] == hashlib.sha256(b"AAAA").hexdigest()
    assert not os.path.exists(a._path("exports"))      # exports are never cached


def test_open_archive_selection(monkeypatch, tmp_path):
    assert isinstance(open_archive(), LocalArchive) and open_archive().root == "data/archive"
    assert not is_remote(open_archive())

    for name, value in (("R2_ACCOUNT_ID", "acc"), ("R2_ACCESS_KEY_ID", "i"),
                        ("R2_SECRET_ACCESS_KEY", "s"), ("R2_BUCKET", "mine")):
        monkeypatch.setenv(name, value)
    remote = open_archive()
    assert isinstance(remote, RemoteArchive) and is_remote(remote)
    assert remote.root == os.path.join(DEFAULT_CACHE, "mine") == "data/cache/mine"
    assert remote.store.bucket == "mine"
    assert open_archive("r2://mine").store.bucket == "mine"

    local = open_archive("file:///x")
    assert isinstance(local, LocalArchive) and not is_remote(local) and local.root == "/x"
    with pytest.raises(ValueError):
        open_archive("r2://other")


def test_open_archive_r2_without_credentials_raises():
    with pytest.raises(ValueError):
        open_archive("r2://mine")


@pytest.mark.parametrize("bad_key", ["records/../../evil.json", "records//x.json", "records/garmin/./x.json"])
def test_remote_sync_rejects_unsafe_store_keys(tmp_path, bad_key):
    store = MemoryStore()
    store.put(bad_key, b"{}")
    cache = tmp_path / "deep" / "cache"
    a = RemoteArchive(store, str(cache))
    with pytest.raises(ValueError, match="unsafe archive key from store"):
        a.list_records()
    assert sorted(p.name for p in tmp_path.rglob("*") if p.is_file()) == []
    assert not (tmp_path / "evil.json").exists() and not (tmp_path / "deep" / "evil.json").exists()


def test_remote_get_blob_rejects_corrupted_store_blob(tmp_path):
    store = MemoryStore()
    sha = hashlib.sha256(b"good").hexdigest()
    store.put(f"raw/{sha}", b"corrupted")
    a = RemoteArchive(store, str(tmp_path / "cache"))
    with pytest.raises(ValueError, match="does not match its hash"):
        a.get_blob(sha)
    assert not os.path.exists(a._path(f"raw/{sha}"))
    store.put(f"raw/{sha}", b"good")
    assert a.get_blob(sha) == b"good" and os.path.exists(a._path(f"raw/{sha}"))


def test_put_export_same_day_same_name_never_overwrites(archive, tmp_path):
    src = tmp_path / "export_123.zip"
    keys = []
    for body in (b"first", b"second", b"third"):
        src.write_bytes(body)
        keys.append(archive.put_export("strava", str(src), today="2026-10-27"))
    assert keys == ["exports/strava/2026-10-27-export_123.zip",
                    "exports/strava/2026-10-27-export_123-2.zip",
                    "exports/strava/2026-10-27-export_123-3.zip"]
    assert [stored_bytes(archive, k) for k in keys] == [b"first", b"second", b"third"]
    # identical content still finds its existing key
    src.write_bytes(b"second")
    assert archive.put_export("strava", str(src), today="2026-10-27") == keys[1]


def test_put_osm_dedupes_and_list_returns_newest(tmp_path):
    a = LocalArchive(str(tmp_path))
    assert a.put_osm("SI", b'{"elements":[]}', fetched_at="2026-11-09T10:00:00+00:00")
    assert not a.put_osm("SI", b'{"elements":[]}', fetched_at="2026-11-09T11:00:00+00:00")
    assert a.put_osm("SI", b'{"elements":[1]}', fetched_at="2026-11-10T10:00:00+00:00")
    assert a.list_osm() == {"SI": b'{"elements":[1]}'}


@pytest.mark.parametrize("bad", ["../x", "si", "SIX", "S", ""])
def test_put_osm_rejects_unsafe_country(tmp_path, bad):
    with pytest.raises(ValueError):
        LocalArchive(str(tmp_path)).put_osm(bad, b"", fetched_at="2026-11-09T10:00:00+00:00")


class _RecordingStore(MemoryStore):
    def __init__(self):
        super().__init__()
        self.gets = []

    def get(self, key):
        self.gets.append(key)
        return super().get(key)


def test_remote_list_osm_fetches_only_newest_per_country(tmp_path):
    store = _RecordingStore()
    writer = RemoteArchive(store, str(tmp_path / "w"))
    writer.put_osm("SI", b"si-old", fetched_at="2026-11-01T10:00:00+00:00")
    writer.put_osm("SI", b"si-new", fetched_at="2026-11-09T10:00:00+00:00")
    writer.put_osm("AT", b"at", fetched_at="2026-11-05T10:00:00+00:00")
    old_key = [k for k, _ in store.list("osm/SI/") if k.startswith("osm/SI/20261101")][0]
    store.gets.clear()

    reader = RemoteArchive(store, str(tmp_path / "r"))
    assert reader.list_osm() == {"SI": b"si-new", "AT": b"at"}
    assert old_key not in store.gets and len(store.gets) == 2
    assert not os.path.exists(reader._path(old_key))
    store.gets.clear()
    assert reader.list_osm() == {"SI": b"si-new", "AT": b"at"}
    assert store.gets == []  # newest keys are cached


def test_remote_put_osm_dedupes_against_store_not_cache(tmp_path):
    store = MemoryStore()
    a, b = RemoteArchive(store, str(tmp_path / "a")), RemoteArchive(store, str(tmp_path / "b"))
    assert a.put_osm("SI", b"x", fetched_at="2026-11-09T10:00:00+00:00")
    assert not b.put_osm("SI", b"x", fetched_at="2026-11-10T10:00:00+00:00")
    assert len(store.list("osm/")) == 1


@pytest.mark.parametrize("bad_key", ["osm/../x.json", "osm/SI/./x.json", "osm//x.json"])
def test_remote_list_osm_rejects_unsafe_store_key(tmp_path, bad_key):
    store = _RecordingStore()
    store.put("osm/SI/20261109T100000Z-aaaaaaaaaaaa.json", b"{}")
    store.put(bad_key, b"{}")
    store.gets.clear()
    with pytest.raises(ValueError, match="unsafe archive key from store"):
        RemoteArchive(store, str(tmp_path / "cache")).list_osm()
    assert store.gets == []
    assert [p for p in tmp_path.rglob("*") if p.is_file()] == []
