import json
import urllib.error

import pytest

from ingest.mcp_server import places
from ingest.mcp_server.places import PlaceFinder, PlaceLookupError

TRIGLAV = [{
    "name": "Triglav", "category": "natural", "type": "peak", "lat": "46.3783000", "lon": "13.8369000",
    "display_name": "Triglav, Občina Bohinj, Slovenija", "extratags": {"ele": "2864"},
}]


class Fetch:
    def __init__(self, result=TRIGLAV):
        self.calls = []
        self.result = result

    def __call__(self, url, params):
        self.calls.append((url, params))
        return self.result


def test_parses_candidates(tmp_path):
    r = PlaceFinder(str(tmp_path / "p.json"), fetch=Fetch()).find("Triglav")
    c = r["data"]["candidates"][0]
    assert c == {"name": "Triglav", "kind": "natural/peak", "lat": 46.3783, "lon": 13.8369,
                 "elevation_m": 2864, "country": "Slovenija"}
    assert r["data"]["cached"] is False


def test_request_shape(tmp_path):
    f = Fetch()
    PlaceFinder(str(tmp_path / "p.json"), fetch=f).find("Triglav")
    url, params = f.calls[0]
    assert url == "https://nominatim.openstreetmap.org/search"
    assert params == {"q": "Triglav", "format": "jsonv2", "limit": 5, "extratags": 1}


def test_user_agent_names_the_app_not_a_person():
    assert places.USER_AGENT == "activity-atlas-mcp/0.1 (+https://github.com/jakaskerjanc/activity-atlas)"
    assert "@" not in places.USER_AGENT


def test_non_numeric_elevation_is_none(tmp_path):
    f = Fetch([{**TRIGLAV[0], "extratags": {"ele": "approx 2864 m"}}])
    assert PlaceFinder(str(tmp_path / "p.json"), fetch=f).find("Triglav")["data"]["candidates"][0][
        "elevation_m"] is None


def test_cached_second_time(tmp_path):
    f = Fetch()
    pf = PlaceFinder(str(tmp_path / "p.json"), fetch=f)
    pf.find("Triglav")
    assert pf.find(" triglav ")["data"]["cached"] is True
    assert len(f.calls) == 1


def test_cache_survives_restart(tmp_path):
    PlaceFinder(str(tmp_path / "sub" / "p.json"), fetch=Fetch()).find("Triglav")
    f = Fetch()
    assert PlaceFinder(str(tmp_path / "sub" / "p.json"), fetch=f).find("Triglav")["data"]["cached"]
    assert f.calls == []
    assert "triglav" in json.loads((tmp_path / "sub" / "p.json").read_text())


def test_rate_limited(tmp_path):
    sleeps = []
    pf = PlaceFinder(str(tmp_path / "p.json"), fetch=Fetch(), clock=lambda: 0.0, sleep=sleeps.append)
    pf.find("a")
    pf.find("b")
    assert sleeps == [1.0]


def test_failure_not_cached(tmp_path):
    def fail(url, params):
        raise urllib.error.HTTPError(url, 429, "Too Many Requests", None, None)

    pf = PlaceFinder(str(tmp_path / "p.json"), fetch=fail)
    with pytest.raises(PlaceLookupError, match="ask the user"):
        pf.find("x")
    assert not (tmp_path / "p.json").exists()


def test_no_results(tmp_path):
    r = PlaceFinder(str(tmp_path / "p.json"), fetch=Fetch([])).find("Nowhere")
    assert r["data"]["candidates"] == []
