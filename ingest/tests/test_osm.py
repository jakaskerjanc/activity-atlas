import json
import os
import sqlite3
import urllib.error
import urllib.parse

import pytest
from ingest import db, osm
from ingest.archive import LocalArchive, RemoteArchive
from ingest.objstore import MemoryStore
from ingest.osm import (OsmError, build_points_file, fetch_country, overpass_query, parse_points, points_file,
                        points_file_name)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def fixture_bytes(name):
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


def body(*elements, **extra):
    return json.dumps({"osm3s": {}, "elements": list(elements), **extra}).encode()


def peak(i, **tags):
    return {"type": "node", "id": i, "lat": 46.0, "lon": 14.0, "tags": {"natural": "peak", "name": f"P{i}", **tags}}


def test_query_names_country():
    assert 'area["ISO3166-1"="SI"]' in overpass_query("SI")


def test_query_allows_norway_size_countries():
    # Norway needs ~385 s server-side; the HTTP wait must outlast Overpass's own limit.
    from ingest import osm
    assert overpass_query("NO").startswith("[out:json][timeout:900];")
    assert osm._TIMEOUT_S > osm.QUERY_TIMEOUT_S


def test_parse_kinds_and_center():
    pts = {p.name: p for p in parse_points(fixture_bytes("overpass_si_small.json"), "SI")}
    assert pts["Slavnik"].kind == "peak" and pts["Slavnik"].ele == 1028
    assert pts["Vršič"].kind == "pass"
    assert pts["Sedlo pod Vrhom"].kind == "pass"
    assert pts["Park Tivoli"].kind == "park" and pts["Park Tivoli"].osm_id.startswith("way/")
    assert (pts["Park Tivoli"].lat, pts["Park Tivoli"].lon) == (46.0569, 14.4950)
    assert pts["Blejsko jezero"].kind == "water"
    assert pts["Koseze"].kind == "neighbourhood"
    assert pts["Zaprevalje"].kind == "hamlet"
    assert len(pts) == 8   # the unnamed and the positionless element are dropped


@pytest.mark.parametrize("ele,expected", [("1028", 1028), ("1028 m", 1028), ("1028,5", 1028.5), ("approx", None)])
def test_parse_ele_variants(ele, expected):
    assert parse_points(body(peak(1, ele=ele)), "SI")[0].ele == expected


def test_parse_missing_ele_is_none():
    assert parse_points(body(peak(1)), "SI")[0].ele is None


def test_parse_drops_unnamed_and_positionless():
    unnamed = {"type": "node", "id": 1, "lat": 1, "lon": 2, "tags": {"natural": "peak"}}
    nowhere = {"type": "way", "id": 2, "tags": {"natural": "peak", "name": "X"}}
    assert [p.osm_id for p in parse_points(body(unnamed, nowhere, peak(3)), "SI")] == ["node/3"]


def test_parse_rejects_html():
    with pytest.raises(OsmError):
        parse_points(b"<html>rate limited</html>", "SI")


def test_parse_rejects_json_without_elements():
    with pytest.raises(OsmError):
        parse_points(b'{"osm3s": {}}', "SI")


def test_parse_rejects_remark():
    remark = 'runtime error: Query timed out in "query" at line 3 after 181 seconds.'
    with pytest.raises(OsmError, match="timed out"):
        parse_points(body(peak(1), remark=remark), "SI")


def file_rows(path):
    c = sqlite3.connect(str(path))
    try:
        return [tuple(r) for r in c.execute("SELECT osm_id, country FROM osm_points ORDER BY osm_id")]
    finally:
        c.close()


class _SpyStore(MemoryStore):
    def __init__(self):
        super().__init__()
        self.gets = []

    def get(self, key):
        self.gets.append(key)
        return super().get(key)


T0, T1 = "2026-11-09T10:00:00+00:00", "2026-11-10T10:00:00+00:00"


def test_points_file_name_follows_the_snapshots():
    assert points_file_name(["osm/SI/a.json"]) == points_file_name(["osm/SI/a.json"])
    assert points_file_name(["osm/SI/a.json", "osm/AT/b.json"]) == points_file_name(["osm/AT/b.json", "osm/SI/a.json"])
    assert points_file_name(["osm/SI/a.json"]) != points_file_name(["osm/SI/b.json"])
    assert points_file_name(["osm/SI/a.json"]).startswith("v1-") and points_file_name([]).endswith(".sqlite")


def test_build_points_file_keeps_a_border_feature_once(tmp_path):
    counts = build_points_file({"SI": body(peak(1)), "AT": body(peak(1))}, str(tmp_path / "p.sqlite"))
    assert counts == {"AT": 1, "SI": 1}
    assert file_rows(tmp_path / "p.sqlite") == [("node/1", "SI")]
    c = sqlite3.connect(str(tmp_path / "p.sqlite"))
    assert c.execute("PRAGMA user_version").fetchone()[0] == 1
    c.close()


def test_points_file_is_none_without_snapshots(tmp_path):
    assert points_file(LocalArchive(str(tmp_path / "a"))) is None


def test_points_file_is_downloaded_once_and_never_rebuilt(tmp_path):
    store = _SpyStore()
    a = RemoteArchive(store, str(tmp_path / "a"))
    a.put_osm("SI", body(peak(1), peak(2)), fetched_at=T0)
    first = points_file(a)                      # built here, stored under derived/osm-points/
    assert [k for k, _ in store.list("derived/")] == ["derived/osm-points/" + points_file_name(a.newest_osm_keys().values())]
    b = RemoteArchive(store, str(tmp_path / "b"))   # another machine, empty cache
    store.gets.clear()
    assert file_rows(points_file(b)) == file_rows(first)
    assert [k for k in store.gets if k.startswith("osm/")] == []     # the snapshots were not fetched
    store.gets.clear()
    points_file(b)
    assert store.gets == []                                           # cached


def test_a_new_snapshot_replaces_the_stored_points_file(tmp_path):
    store = MemoryStore()
    a = RemoteArchive(store, str(tmp_path / "a"))
    a.put_osm("SI", body(peak(1)), fetched_at=T0)
    old = points_file(a)
    a.put_osm("SI", body(peak(1), peak(2)), fetched_at=T1)
    new = points_file(a)
    assert file_rows(new) == [("node/1", "SI"), ("node/2", "SI")]
    assert len(store.list("derived/osm-points/")) == 1
    assert not os.path.exists(old)


def test_local_points_file_is_built_once(tmp_path):
    a = LocalArchive(str(tmp_path / "a"))
    a.put_osm("SI", body(peak(1)), fetched_at=T0)
    p = points_file(a)
    mtime = os.stat(p).st_mtime_ns
    assert points_file(a) == p and os.stat(p).st_mtime_ns == mtime


def test_points_file_store_error_is_raised(tmp_path):
    class Broken(MemoryStore):
        def get(self, key):
            raise OSError("R2 is down")
    store = Broken()
    a = RemoteArchive(store, str(tmp_path / "a"))
    a.put_osm("SI", body(peak(1)), fetched_at=T0)
    with pytest.raises(OSError, match="R2 is down"):
        points_file(a)


def test_fetch_sends_query_and_user_agent():
    seen = {}

    def post(url, data, headers):
        seen.update(url=url, data=data, headers=headers)
        return 200, body(peak(1))
    assert fetch_country("SI", post) == body(peak(1))
    assert seen["url"] == osm.OVERPASS_URL
    assert seen["headers"]["User-Agent"] == osm.USER_AGENT
    assert b"ISO3166-1" in seen["data"]


def test_fetch_raises_on_429():
    post = lambda *a, **k: (429, b"Too Many Requests")  # noqa: E731
    with pytest.raises(OsmError, match="SI: .*429"):
        fetch_country("SI", post)


def test_fetch_raises_on_zero_points():
    post = lambda *a, **k: (200, b'{"osm3s":{},"elements":[]}')  # noqa: E731
    with pytest.raises(OsmError, match="SI: "):
        fetch_country("SI", post)


@pytest.mark.parametrize("error", [urllib.error.URLError("[Errno -3] Temporary failure in name resolution"),
                                   TimeoutError("The read operation timed out"),
                                   ConnectionResetError(104, "Connection reset by peer")])
def test_fetch_turns_network_errors_into_osm_error(error):
    def post(url, data, headers):
        raise error
    with pytest.raises(OsmError, match="SI: "):
        fetch_country("SI", post)


def _country_of(data):
    return "SI" if '"ISO3166-1"="SI"' in urllib.parse.unquote_plus(data.decode()) else "AT"


@pytest.fixture
def cli(tmp_path, monkeypatch):
    monkeypatch.setattr(osm.time, "sleep", lambda s: None)
    archive_dir = tmp_path / "archive"
    db_path = str(tmp_path / "a.sqlite")

    def run(*countries):
        monkeypatch.setattr("sys.argv", ["osm", *countries, "--db", db_path, "--archive", f"file://{archive_dir}"])
        osm.main()
    return run, archive_dir, db_path


def test_main_writes_nothing_when_one_country_fails(cli, monkeypatch):
    run, archive_dir, db_path = cli
    answers = {"SI": (200, body(peak(1))), "AT": (504, b"Gateway Timeout")}
    monkeypatch.setattr(osm, "_http_post", lambda url, data, headers: answers[_country_of(data)])
    with pytest.raises(SystemExit, match="AT"):
        run("SI", "AT")
    assert not (archive_dir / "osm").exists()
    assert not os.path.exists(db_path)


def test_main_writes_nothing_when_a_country_times_out(cli, monkeypatch):
    run, archive_dir, db_path = cli
    remark = 'runtime error: Query timed out in "query" at line 3 after 181 seconds.'
    answers = {"SI": (200, body(peak(1))), "AT": (200, body(peak(2), remark=remark))}
    monkeypatch.setattr(osm, "_http_post", lambda url, data, headers: answers[_country_of(data)])
    with pytest.raises(SystemExit, match="timed out"):
        run("SI", "AT")
    assert not (archive_dir / "osm").exists()
    assert not os.path.exists(db_path)


def test_main_writes_nothing_on_a_network_error(cli, monkeypatch):
    run, archive_dir, db_path = cli

    def post(url, data, headers):
        if _country_of(data) == "AT":
            raise urllib.error.URLError("[Errno 111] Connection refused")
        return 200, body(peak(1))
    monkeypatch.setattr(osm, "_http_post", post)
    with pytest.raises(SystemExit, match="AT: .*Connection refused.*nothing was written"):
        run("SI", "AT")
    assert not (archive_dir / "osm").exists()
    assert not os.path.exists(db_path)


def test_main_rebuilds_a_v4_database_and_builds_the_points_file(cli, monkeypatch, capsys):
    run, archive_dir, db_path = cli
    c = db.open_db(db_path)
    c.execute("PRAGMA user_version = 4")
    c.commit()
    c.close()
    monkeypatch.setattr(osm, "_http_post", lambda url, data, headers: (200, body(peak(1), peak(2))))
    run("SI")
    c = sqlite3.connect(db_path)
    assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 6
    assert c.execute("SELECT 1 FROM sqlite_master WHERE name = 'osm_points'").fetchone() is None
    c.close()
    p = points_file(LocalArchive(str(archive_dir)))
    assert file_rows(p) == [("node/1", "SI"), ("node/2", "SI")]
    assert "SI: 2 points" in capsys.readouterr().out
