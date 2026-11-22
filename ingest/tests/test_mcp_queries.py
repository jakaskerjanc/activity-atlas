"""The design's example queries (#35), called through the server as an LLM calls the tools.

Nominatim is mocked (place_fixture.NOMINATIM). Where a query needs a radius, the test picks it.
"""
import asyncio
import json
import sqlite3

import pytest

from ingest.mcp_server.database import Database
from ingest.mcp_server.freshness import Syncer
from ingest.mcp_server.places import PlaceFinder
from ingest.mcp_server.server import ServerContext, build_server
from ingest.tests import place_fixture
from ingest.tests.mcp_fixture import build_fixture_db


@pytest.fixture
def qctx(tmp_path):
    """The MCP fixture plus the place activities, written before Database builds its text table."""
    path = build_fixture_db(str(tmp_path / "f.sqlite"))
    conn = sqlite3.connect(path)
    place_fixture.add_place_activities(conn)
    conn.commit()
    conn.close()
    place_fixture.calls.clear()
    c = ServerContext(db=Database(path), syncer=Syncer(path, None),
                      places=PlaceFinder(str(tmp_path / "places.json"), fetch=place_fixture.fetch))
    yield c
    c.db.close()


def call(ctx, name, args):
    r = asyncio.run(build_server(ctx).call_tool(name, args))
    return json.loads(r.content[0].text)


def ids_of(result):
    return [r["id"] for r in result["data"]["rows"]]


def candidates(ctx, query):
    return call(ctx, "find_place", {"query": query})["data"]["candidates"]


def near(ctx, place, radius_m, **args):
    return call(ctx, "activities_near", {"lat": place["lat"], "lon": place["lon"], "radius_m": radius_m, **args})


def test_hikes_to_slavnik(qctx):
    """All hikes to Slavnik"""
    r = call(qctx, "list_activities", {"types": ["Hike"], "place": "slavnik"})
    assert ids_of(r) == ["slavnik2", "slavnik1"]
    assert "place: slavnik" in r["counted"]["rules"]


def test_hiking_near_jesenice(qctx):
    """Hiking near Jesenice"""
    found = candidates(qctx, "Jesenice")
    assert [c["kind"] for c in found[:2]] == ["boundary/administrative", "place/town"]
    town = found[1]
    assert town["country"] == "Slovenija" and len(found) == 5
    assert place_fixture.calls[0]["q"] == "Jesenice" and place_fixture.calls[0]["limit"] == 5
    r = near(qctx, town, 3000, types=["Hike"])
    assert ids_of(r) == ["jes_hike"] and r["data"]["nearest"] is None


def test_hiking_near_jesenice_none_close(qctx):
    """Hiking near Jesenice, none close"""
    town = candidates(qctx, "Jesenice")[1]
    r = near(qctx, town, 3000, types=["Hike"], date_to="2025-05-31")
    assert r["data"]["total"] == 0
    assert r["data"]["nearest"]["id"] == "far_hike"
    assert 11500 < r["data"]["nearest"]["closest_m"] < 12500


def test_walks_around_lake_bled(qctx):
    """Walks around Lake Bled"""
    lake = candidates(qctx, "Lake Bled")[0]
    assert lake["name"] == "Blejsko jezero" and lake["kind"] == "water/lake" and lake["elevation_m"] == 475
    assert ids_of(near(qctx, lake, 700, types=["Walk"])) == ["bled_walk"]


def test_runs_from_ljubljana(qctx):
    """Runs from Ljubljana"""
    city = candidates(qctx, "Ljubljana")[0]
    assert city["kind"] == "place/city"
    r = near(qctx, city, 5000, mode="start", types=["Run"])
    assert ids_of(r) == ["lj_run1", "lj_run2"]
    dists = [row["closest_m"] for row in r["data"]["rows"]]
    assert dists == sorted(dists) and 400 < dists[0] < 600 and 1400 < dists[1] < 1600


def test_rides_over_vrsic(qctx):
    """Rides over Vršič"""
    r = call(qctx, "list_activities", {"types": ["Ride"], "text": "vršič"})
    assert ids_of(r) == ["vrsic_ride"]  # its name doesn't say Vršič; its place "Prelaz Vršič" does
    assert candidates(qctx, "Vršič") == []  # not in the mock, as Nominatim doesn't list the pass


def test_smarna_gora_without_accents(qctx):
    """Šmarna gora, typed without accents"""
    assert ids_of(call(qctx, "list_activities", {"text": "smarna gora"})) == ["smarna1"]
    assert ids_of(call(qctx, "list_activities", {"name_contains": "smarna"})) == ["smarna1"]


def test_cold_rainy_walks(qctx):
    """Cold rainy walks"""
    r = call(qctx, "list_activities", {"types": ["Walk"], "text": "cold rain"})
    assert ids_of(r) == ["walk1"]
    assert "description" not in r["data"]["rows"][0]
    assert "Rain" not in json.dumps(r) and "Weather" not in json.dumps(r)
