import asyncio
import json
import os
import sys
import threading
import time

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from ingest.mcp_server.__main__ import main
from ingest.mcp_server.database import Database
from ingest.mcp_server.freshness import Syncer
from ingest.mcp_server.guide import guide_text
from ingest.mcp_server.places import PlaceFinder
from ingest.mcp_server.server import ServerContext, build_server
from ingest.objstore import MemoryStore
from ingest.tests.mcp_fixture import build_fixture_db, slow_store, with_extra_activity

TOOLS = {"guide", "sync", "list_activities", "get_activity", "summarize", "activity_samples", "wellness",
         "wellness_series", "find_place", "activities_near", "query", "places", "same_route"}


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


def tool_names(ctx):
    return {t.name for t in asyncio.run(build_server(ctx).list_tools())}


def test_tools_registered(ctx):
    assert {"places", "same_route"} <= tool_names(ctx)


def test_place_filter_and_group_tools(ctx):
    assert [r["id"] for r in call(ctx, "list_activities", {"place": "Slavnik"})["data"]["rows"]] == [
        "slavnik2", "slavnik1"]
    assert call(ctx, "summarize", {"place": "grmada", "period": "all"})["data"]["rows"][0]["count"] == 2
    assert call(ctx, "places", {})["data"]["places"][0]["name"] == "Slavnik"
    r = call(ctx, "same_route", {"activity_id": "slavnik2"})
    assert r["data"]["route"]["id"] == "slavnik1" and "as_of" in r


def test_unknown_place_is_a_tool_error(ctx):
    with pytest.raises(ToolError, match="places tool"):
        asyncio.run(build_server(ctx).call_tool("list_activities", {"place": "Nowhere"}))


def test_v4_database_group_tools_are_tool_errors(ctx):  # review focus 5
    import sqlite3
    ctx.db.close()
    conn = sqlite3.connect(ctx.db.path)
    for table in ("places", "route_groups", "activity_groups"):
        conn.execute(f"DROP TABLE {table}")
    conn.commit()
    conn.close()
    ctx.db.reopen()
    server = build_server(ctx)
    for name, args in [("places", {}), ("same_route", {"activity_id": "run1"}),
                       ("list_activities", {"place": "Slavnik"}), ("summarize", {"place": "Slavnik"})]:
        with pytest.raises(ToolError, match="no places yet"):
            asyncio.run(server.call_tool(name, args))
    assert call(ctx, "list_activities", {})["data"]["total"] == 11
    assert call(ctx, "summarize", {"period": "all", "by_type": False})["data"]["rows"][0]["count"] == 11


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
    assert call(ctx, "query", {"sql": "select count(*) from activities"})["data"]["rows"] == [[12]]


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


def test_tools_answer_while_a_slow_download_runs(ctx, tmp_path):  # issue #54
    store = slow_store(tmp_path, ctx.db.path)
    ctx.syncer.store = store
    server = build_server(ctx)
    try:
        t0 = time.monotonic()
        r = json.loads(asyncio.run(server.call_tool("guide", {})).content[0].text)
        assert store.started.wait(5)  # the first call started the check and did not wait for it
        for name, args in [("guide", {}), ("list_activities", {})]:
            t1 = time.monotonic()
            r = json.loads(asyncio.run(server.call_tool(name, args)).content[0].text)
            assert time.monotonic() - t1 < 1
            assert r["as_of"]["sync"] == "downloading a newer database (1 of 3 MB)"
            assert r["notice"].startswith("The local database is out of date") and "older copy" in r["notice"]
        assert "extra" not in [row["id"] for row in r["data"]["rows"]]
        assert time.monotonic() - t0 < 2
    finally:
        store.release.set()
    assert ctx.syncer.wait(5)
    r = json.loads(asyncio.run(server.call_tool("list_activities", {})).content[0].text)
    assert "extra" in [row["id"] for row in r["data"]["rows"]]
    assert r["as_of"]["sync"] == "downloaded" and "notice" not in r


def test_first_call_waits_for_the_check_but_not_long(ctx, tmp_path):
    release = threading.Event()

    class SlowHead(MemoryStore):
        def head(self, key):
            release.wait(5)
            return super().head(key)

    ctx.syncer.store = SlowHead()
    try:
        t0 = time.monotonic()
        r = call(ctx, "guide", {})
        assert 0.9 < time.monotonic() - t0 < 2  # waited for the check, then gave up on it
        assert r["notice"].startswith("Still checking R2")
    finally:
        release.set()
    ctx.syncer.wait(5)
    assert "notice" not in call(ctx, "guide", {})  # R2 has no database: nothing to say


def test_without_a_database_tools_say_it_is_downloading(tmp_path):
    path = build_fixture_db(str(tmp_path / "seed.sqlite"))
    target = str(tmp_path / "data" / "activities.sqlite")
    store = slow_store(tmp_path, path)
    c = ServerContext(db=None, syncer=Syncer(target, store), places=PlaceFinder(str(tmp_path / "p.json")))
    server = build_server(c)
    assert "still being downloaded" in server.instructions
    try:
        c.syncer.start(force=True)
        assert store.started.wait(5)
        for name in ("guide", "list_activities"):
            t0 = time.monotonic()
            with pytest.raises(ToolError, match=r"no local database yet: .* \(1 of 3 MB\)\. Try again"):
                asyncio.run(server.call_tool(name, {}))
            assert time.monotonic() - t0 < 1
    finally:
        store.release.set()
    assert c.syncer.wait(5)
    r = json.loads(asyncio.run(server.call_tool("list_activities", {})).content[0].text)
    assert "extra" in [row["id"] for row in r["data"]["rows"]] and "notice" not in r
    c.db.close()


def test_sync_tool_waits_then_reports_progress(ctx, tmp_path, monkeypatch):
    monkeypatch.setattr("ingest.mcp_server.server.SYNC_TOOL_WAIT_S", 0.2)
    store = slow_store(tmp_path, ctx.db.path)
    ctx.syncer.store = store
    server = build_server(ctx)
    try:
        r = json.loads(asyncio.run(server.call_tool("sync", {})).content[0].text)
        assert r["as_of"]["sync"].startswith("downloading a newer database")
        threading.Timer(0.05, store.release.set).start()  # finishes while the next call waits on it
        r = json.loads(asyncio.run(server.call_tool("sync", {})).content[0].text)
    finally:
        store.release.set()
    assert r["as_of"]["sync"] == "downloaded"
    assert r["as_of"]["newest_activity"] == "2026-11-04T08:00:00"


def test_download_never_holds_the_tool_lock(ctx, tmp_path):
    store = slow_store(tmp_path, ctx.db.path)
    ctx.syncer.store = store
    try:
        ctx.syncer.start()
        assert store.started.wait(5)
        assert ctx.lock.acquire(timeout=0.5)
        ctx.lock.release()
    finally:
        store.release.set()
        ctx.syncer.wait(5)


def test_file_replaced_by_another_process_is_reread(ctx, tmp_path):  # review Important 2
    from ingest import writer
    other = str(tmp_path / "other.sqlite")
    data = with_extra_activity(tmp_path, ctx.db.path)
    with open(other, "wb") as fh:
        fh.write(data)
    server = build_server(ctx)
    asyncio.run(server.call_tool("list_activities", {}))  # opens and uses the old file
    writer.install(other, ctx.db.path)  # what `npm run sync` or a local import does
    r = json.loads(asyncio.run(server.call_tool("list_activities", {})).content[0].text)
    assert "extra" in [row["id"] for row in r["data"]["rows"]]
    assert r["as_of"]["newest_activity"] == "2026-11-04T08:00:00"


def test_main_does_not_wait_for_r2_before_serving(tmp_path, monkeypatch):  # review Important 5, #54
    path = build_fixture_db(str(tmp_path / "f.sqlite"))
    checking, release = threading.Event(), threading.Event()

    class Store:
        def head(self, key):
            checking.set()
            release.wait(5)
            return None

    served = []

    def serve(ctx):
        def run(self, transport):
            assert checking.wait(5)  # the check is running, in the background
            served.append(transport)
            release.set()
        return type("S", (), {"run": run})()

    monkeypatch.setattr("ingest.mcp_server.__main__.store_from_env", lambda read_only: Store())
    monkeypatch.setattr("ingest.mcp_server.__main__.build_server", serve)
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", path])
    try:
        main()
    finally:
        release.set()
    assert served == ["stdio"]


def test_main_serves_at_once_without_a_database(tmp_path, monkeypatch):  # #54
    seed = build_fixture_db(str(tmp_path / "seed.sqlite"))
    path = str(tmp_path / "data" / "activities.sqlite")
    store = slow_store(tmp_path, seed)
    served = []

    def serve(ctx):
        def run(self, transport):
            assert ctx.db is None and store.started.wait(5)  # downloading, in the background
            served.append(transport)
        return type("S", (), {"run": run})()

    monkeypatch.setattr("ingest.mcp_server.__main__.store_from_env", lambda read_only: store)
    monkeypatch.setattr("ingest.mcp_server.__main__.build_server", serve)
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", path])
    main()  # stops the download on the way out
    assert served == ["stdio"]
    assert not os.path.exists(path) and [f for f in os.listdir(os.path.dirname(path)) if ".pull-" in f] == []


def test_main_refuses_missing_db_with_no_sync(tmp_path, monkeypatch):
    monkeypatch.setattr("ingest.mcp_server.__main__.store_from_env", lambda read_only: MemoryStore())
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", str(tmp_path / "missing.sqlite"), "--no-sync"])
    with pytest.raises(SystemExit) as e:
        main()
    assert e.value.code == 2


def test_main_refuses_missing_db_without_r2(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["mcp_server", "--db", str(tmp_path / "missing.sqlite")])
    with pytest.raises(SystemExit) as e:
        main()
    assert e.value.code == 2
