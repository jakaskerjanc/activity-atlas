import json
import os
import sqlite3
import urllib.error
import urllib.parse

import pytest
from ingest import db, osm
from ingest.osm import OsmError, apply_osm, fetch_country, overpass_query, parse_points

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def fixture_bytes(name):
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


def body(*elements, **extra):
    return json.dumps({"osm3s": {}, "elements": list(elements), **extra}).encode()


def peak(i, **tags):
    return {"type": "node", "id": i, "lat": 46.0, "lon": 14.0, "tags": {"natural": "peak", "name": f"P{i}", **tags}}


@pytest.fixture
def conn(tmp_path):
    c = db.open_db(str(tmp_path / "t.sqlite"))
    yield c
    c.close()


def test_query_names_country():
    assert 'area["ISO3166-1"="SI"]' in overpass_query("SI")


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


def rows(conn, country):
    return sorted(r[0] for r in conn.execute("SELECT name FROM osm_points WHERE country = ?", (country,)))


def test_apply_replaces_only_that_country(conn):
    assert apply_osm(conn, {"SI": body(peak(1), peak(2)), "AT": body(peak(3))}) == 3
    assert apply_osm(conn, {"SI": body(peak(4))}) == 1
    assert rows(conn, "SI") == ["P4"]
    assert rows(conn, "AT") == ["P3"]


def test_apply_survives_a_feature_returned_for_two_countries(conn):
    apply_osm(conn, {"SI": body(peak(1)), "AT": body(peak(1))})
    assert conn.execute("SELECT COUNT(*) FROM osm_points").fetchone()[0] == 1


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


def test_main_rebuilds_a_v4_database_and_loads_points(cli, monkeypatch, capsys):
    run, archive_dir, db_path = cli
    c = db.open_db(db_path)
    c.execute("PRAGMA user_version = 4")
    c.commit()
    c.close()
    monkeypatch.setattr(osm, "_http_post", lambda url, data, headers: (200, body(peak(1), peak(2))))
    run("SI")
    c = sqlite3.connect(db_path)
    assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 5
    assert rows(c, "SI") == ["P1", "P2"]
    c.close()
    assert "SI: 2 points" in capsys.readouterr().out
