import asyncio
import json
import sys

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from ingest.mcp_server.__main__ import main
from ingest.mcp_server.database import Database
from ingest.mcp_server.freshness import Syncer
from ingest.mcp_server.guide import guide_text
from ingest.mcp_server.places import PlaceFinder
from ingest.mcp_server.server import ServerContext, build_server
from ingest.tests.mcp_fixture import build_fixture_db

TOOLS = {"guide", "sync", "list_activities", "get_activity", "summarize", "activity_samples", "wellness",
         "wellness_series", "find_place", "activities_near", "query"}


@pytest.fixture
def ctx(tmp_path):
    path = build_fixture_db(str(tmp_path / "f.sqlite"))
    fetch = lambda url, params: [{"name": "Triglav", "category": "natural", "type": "peak",  # noqa: E731
                                  "lat": "46.3783", "lon": "13.8369", "display_name": "Triglav, Slovenija"}]
    c = ServerContext(db=Database(path), syncer=Syncer(path, None),
                      places=PlaceFinder(str(tmp_path / "places.json"), fetch=fetch))
    yield c
    c.db.close()


def call(ctx, name, args):
    r = asyncio.run(build_server(ctx).call_tool(name, args))
    return json.loads(r.content[0].text)


def test_lists_all_tools(ctx):
    tools = asyncio.run(build_server(ctx).list_tools())
    assert {t.name for t in tools} == TOOLS
    assert all(t.description for t in tools)
    read_only = {t.name for t in tools if t.annotations and t.annotations.read_only_hint}
    assert read_only == TOOLS - {"sync", "find_place"}


def test_every_result_has_as_of_and_counted(ctx):
    r = call(ctx, "summarize", {"types": ["Run"], "period": "year"})
    assert {"data", "counted", "as_of"} <= set(r)
    assert r["as_of"]["sync"] == "no R2"


def test_flat_filter_params(ctx):
    r = call(ctx, "list_activities", {"types": ["Run"], "date_from": "2026-01-01"})
    assert [row["id"] for row in r["data"]["rows"]] == ["run3"]


def test_near_with_place(ctx):
    place = call(ctx, "find_place", {"query": "Triglav"})["data"]["candidates"][0]
    r = call(ctx, "activities_near", {"lat": place["lat"], "lon": place["lon"]})
    assert [row["id"] for row in r["data"]["rows"]] == ["hike1"]


def test_query_tool(ctx):
    assert call(ctx, "query", {"sql": "select count(*) from activities"})["data"]["rows"] == [[7]]


def test_expected_errors_reach_the_model(ctx):
    with pytest.raises(ToolError, match="no activity nope"):
        asyncio.run(build_server(ctx).call_tool("get_activity", {"activity_id": "nope"}))
    with pytest.raises(ToolError, match="not authorized"):
        asyncio.run(build_server(ctx).call_tool("query", {"sql": "delete from activities"}))


def test_sync_tool_forces_a_check(ctx):
    r = call(ctx, "sync", {})
    assert r["as_of"]["sync"] == "no R2" and r["as_of"]["last_sync_check"]


def test_guide_has_live_coverage(ctx):
    g = guide_text(ctx.db)
    assert "Run: 4" in g and "hr: 2025-03-10..2025-03-10" in g
    assert "total moving time / total distance" in g


def test_server_instructions_are_the_guide(ctx):
    assert build_server(ctx).instructions == guide_text(ctx.db)


def test_tool_bodies_and_sync_run_under_one_lock(ctx, monkeypatch):  # review Important 1
    seen = []
    real_sync = ctx.syncer.maybe_sync

    def checking_sync(force=False):
        seen.append(("sync", ctx.lock._is_owned()))
        return real_sync(force)

    monkeypatch.setattr(ctx.syncer, "maybe_sync", checking_sync)
    real_list = __import__("ingest.mcp_server.activities", fromlist=["x"]).list_activities

    def checking_list(*a, **k):
        seen.append(("tool", ctx.lock._is_owned()))
        return real_list(*a, **k)

    monkeypatch.setattr("ingest.mcp_server.activities.list_activities", checking_list)
    call(ctx, "list_activities", {})
    assert seen == [("sync", True), ("tool", True)]


def test_file_replaced_by_another_process_is_reread(ctx, tmp_path):  # review Important 2
    import sqlite3

    from ingest import writer
    other = str(tmp_path / "other.sqlite")
    with open(ctx.db.path, "rb") as src, open(other, "wb") as dst:
        dst.write(src.read())
    c = sqlite3.connect(other)
    c.execute("INSERT INTO activities (id, type, start_time, start_local, visible) "
              "VALUES ('extra', 'Run', '2026-11-04T07:00:00+00:00', '2026-11-04T08:00:00', 1)")
    c.commit()
    c.close()
    server = build_server(ctx)
    asyncio.run(server.call_tool("list_activities", {}))  # opens and uses the old file
    writer.install(other, ctx.db.path)  # what `npm run sync` or a local import does
    r = json.loads(asyncio.run(server.call_tool("list_activities", {})).content[0].text)
    assert "extra" in [row["id"] for row in r["data"]["rows"]]
    assert r["as_of"]["newest_activity"] == "2026-11-04T08:00:00"


def test_main_does_not_sync_before_serving_when_the_db_exists(tmp_path, monkeypatch):  # review Important 5
    path = build_fixture_db(str(tmp_path / "f.sqlite"))
    heads = []

    class Store:
        def head(self, key):
            heads.append(key)
            return None

    served = []
    monkeypatch.setattr("ingest.mcp_server.__main__.store_from_env", lambda read_only: Store())
    monkeypatch.setattr("ingest.mcp_server.__main__.build_server",
                        lambda ctx: type("S", (), {"run": lambda self, t: served.append(t)})())
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", path])
    main()
    assert served == ["stdio"] and heads == []


def test_main_refuses_missing_db_without_r2(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", str(tmp_path / "missing.sqlite")])
    with pytest.raises(SystemExit) as e:
        main()
    assert e.value.code == 2
