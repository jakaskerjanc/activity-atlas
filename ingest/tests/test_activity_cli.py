import re
import sys
import warnings

import pytest

from ingest import activity_cli, archive as archive_mod, db, writer
from ingest.archive import LocalArchive
from ingest.objstore import MemoryStore
from ingest.garmin_import import GarminImporter
from ingest.strava_import import StravaImporter
from ingest.tests.factories import NOW, fresh, src
from ingest.tests.test_garmin_import import _garmin_zip
from ingest.tests.test_rebuild import _imported
from ingest.tests.test_strava_import import HEADER, _row, _zip
from ingest import matcher
from ingest.refresh import refresh
from ingest.tests.test_grouping import A, N, _loop_from
from ingest.tests.test_refresh import _fill, _rows, build_db
from ingest.tests.track_fixture import climb_alts, insert_activity, offset

ID_RE = re.compile(r"^[a-z0-9]{10}$")


def _aid(conn, provider, pid):
    return conn.execute("SELECT activity_id FROM activity_sources WHERE provider=? AND provider_activity_id=?",
                        (provider, pid)).fetchone()[0]


def _imports(tmp_path):
    """Strava gym at 08:40 and Garmin gym at 06:40 on Aug 6: two hours apart, not auto-merged."""
    dbp, arch = str(tmp_path / "db.sqlite"), LocalArchive(str(tmp_path / "arch"))
    gym = _row(222, "Aug 6, 2026, 8:40:00 AM", "Strength", "Weight Training", elapsed="2400", distance="0")
    strava_zip, garmin_zip = _zip(tmp_path, HEADER + gym, {}), _garmin_zip(tmp_path)

    def run():
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            StravaImporter(strava_zip, dbp, arch, now=NOW).run()
            GarminImporter(garmin_zip, dbp, arch, now=NOW).run()
    run()
    return dbp, run


def test_merge_moves_sources_pins_and_survives_reimport(tmp_path):
    dbp, reimport = _imports(tmp_path)
    conn = db.connect(dbp)
    keep, other = _aid(conn, "strava", "222"), _aid(conn, "garmin", "900002")
    assert keep != other
    activity_cli.merge(conn, keep, other)
    conn.commit()
    rows = conn.execute("SELECT pinned FROM activity_sources WHERE activity_id=?", (keep,)).fetchall()
    assert len(rows) == 2 and all(r[0] == 1 for r in rows)
    assert conn.execute("SELECT 1 FROM activities WHERE id=?", (other,)).fetchone() is None
    assert conn.execute("SELECT name FROM activities WHERE id=?", (keep,)).fetchone()[0] == "Strength"
    conn.close()
    reimport()
    conn = db.connect(dbp)
    assert _aid(conn, "garmin", "900002") == keep == _aid(conn, "strava", "222")
    assert conn.execute("SELECT 1 FROM activities WHERE id=?", (other,)).fetchone() is None


def test_split_creates_new_pinned_activity(tmp_path):
    dbp, arch = _imported(tmp_path)
    conn = db.connect(dbp)
    merged = _aid(conn, "strava", "111")
    assert _aid(conn, "garmin", "900001") == merged
    new = activity_cli.split(conn, merged, "garmin", "900001")
    conn.commit()
    assert ID_RE.match(new) and new != merged
    assert _aid(conn, "garmin", "900001") == new and _aid(conn, "strava", "111") == merged
    pins = conn.execute("SELECT pinned FROM activity_sources WHERE activity_id IN (?, ?)", (merged, new)).fetchall()
    assert [p[0] for p in pins] == [1, 1]
    assert conn.execute("SELECT name FROM activities WHERE id=?", (new,)).fetchone()[0] == "Match Run"
    conn.close()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        GarminImporter(_garmin_zip(tmp_path, run_distance_cm=466285), dbp, arch, now=NOW).run()
    conn = db.connect(dbp)
    assert _aid(conn, "garmin", "900001") == new and _aid(conn, "strava", "111") == merged


def test_split_only_source_raises():
    conn = fresh()
    matcher.reconcile(conn, src("strava", "1"), now=NOW)
    aid = _aid(conn, "strava", "1")
    with pytest.raises(ValueError):
        activity_cli.split(conn, aid, "strava", "1")


def test_split_unknown_source_raises():
    conn = fresh()
    matcher.reconcile(conn, src("strava", "1"), now=NOW)
    with pytest.raises(ValueError):
        activity_cli.split(conn, _aid(conn, "strava", "1"), "garmin", "404")


def test_hide_and_unhide_toggle_visible():
    conn = fresh()
    matcher.reconcile(conn, src("strava", "1"), now=NOW)
    aid = _aid(conn, "strava", "1")
    activity_cli.set_hidden(conn, aid, True)
    assert conn.execute("SELECT visible FROM activities WHERE id=?", (aid,)).fetchone()[0] == 0
    activity_cli.set_hidden(conn, aid, False)
    assert conn.execute("SELECT visible FROM activities WHERE id=?", (aid,)).fetchone()[0] == 1


def test_cli_hide(tmp_path, monkeypatch):
    dbp, _ = _imports(tmp_path)
    conn = db.connect(dbp)
    aid = _aid(conn, "strava", "222")
    conn.close()
    monkeypatch.setattr(sys, "argv", ["activity", "hide", aid, "--db", dbp])
    activity_cli.main()
    conn = db.connect(dbp)
    assert conn.execute("SELECT visible FROM activities WHERE id=?", (aid,)).fetchone()[0] == 0


def test_hide_through_r2(tmp_path, monkeypatch):
    dbp, _ = _imports(tmp_path)
    conn = db.connect(dbp)
    aid = _aid(conn, "strava", "222")
    conn.close()
    store = MemoryStore()
    store.bucket = "bkt"
    store.put(writer.DB_KEY, open(dbp, "rb").read())
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("R2_BUCKET", "bkt")
    monkeypatch.setattr(archive_mod, "store_from_env", lambda: store)
    local = str(tmp_path / "synced.sqlite")
    monkeypatch.setattr(sys, "argv", ["activity", "hide", aid, "--db", local])
    activity_cli.main()
    remote = str(tmp_path / "remote.sqlite")
    open(remote, "wb").write(store.get(writer.DB_KEY)[0])
    conn = db.connect(remote)
    assert conn.execute("SELECT hidden FROM activity_overrides WHERE activity_id=?", (aid,)).fetchone()[0] == 1
    conn.close()
    conn = db.connect(local)    # the local copy follows R2
    assert _visible(conn, aid) == 0


def test_cli_split_parses_provider_ref(tmp_path, monkeypatch, capsys):
    dbp, _ = _imported(tmp_path)
    conn = db.connect(dbp)
    merged = _aid(conn, "strava", "111")
    conn.close()
    monkeypatch.setattr(sys, "argv", ["activity", "split", merged, "garmin:900001", "--db", dbp])
    activity_cli.main()
    new = capsys.readouterr().out.strip().split()[-1]
    conn = db.connect(dbp)
    assert _aid(conn, "garmin", "900001") == new


def _visible(conn, aid):
    return conn.execute("SELECT visible FROM activities WHERE id=?", (aid,)).fetchone()[0]


def test_split_of_hidden_activity_keeps_both_hidden(tmp_path):
    dbp, _ = _imported(tmp_path)
    conn = db.connect(dbp)
    merged = _aid(conn, "strava", "111")
    activity_cli.set_hidden(conn, merged, True)
    new = activity_cli.split(conn, merged, "garmin", "900001")
    assert _visible(conn, merged) == 0 and _visible(conn, new) == 0


def test_merge_with_hidden_activity_stays_hidden(tmp_path):
    dbp, _ = _imports(tmp_path)
    conn = db.connect(dbp)
    keep, other = _aid(conn, "strava", "222"), _aid(conn, "garmin", "900002")
    activity_cli.set_hidden(conn, other, True)
    activity_cli.merge(conn, keep, other)
    assert _visible(conn, keep) == 0


def test_split_redone_after_412_prints_one_line(tmp_path, monkeypatch, capsys):
    dbp, _ = _imported(tmp_path)
    conn = db.connect(dbp)
    merged = _aid(conn, "strava", "111")
    conn.close()
    store = MemoryStore()
    store.bucket = "bkt"
    store.put(writer.DB_KEY, open(dbp, "rb").read())
    real_put, raced = store.put, []

    def racing_put(key, data, **kw):
        if key == writer.DB_KEY and not raced:      # another writer lands first: 412 for us
            raced.append(True)
            other = str(tmp_path / "other.sqlite")
            open(other, "wb").write(store.get(writer.DB_KEY)[0])
            c = db.open_db(other)
            c.execute("INSERT INTO gear (provider, name) VALUES ('strava', 'raced')")
            c.commit()
            c.close()
            real_put(writer.DB_KEY, open(other, "rb").read())
        return real_put(key, data, **kw)

    monkeypatch.setattr(store, "put", racing_put)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("R2_BUCKET", "bkt")
    monkeypatch.setattr(archive_mod, "store_from_env", lambda: store)
    monkeypatch.setattr(sys, "argv", ["activity", "split", merged, "garmin:900001", "--db", str(tmp_path / "l.sqlite")])
    activity_cli.main()
    assert raced
    out = capsys.readouterr().out
    assert len([ln for ln in out.splitlines() if ln.startswith("split ")]) == 1
    remote = str(tmp_path / "remote.sqlite")
    open(remote, "wb").write(store.get(writer.DB_KEY)[0])
    conn = db.connect(remote)
    assert _aid(conn, "garmin", "900001") == out.strip().split()[-1]


# --- places and same routes: owner names and merges ---

@pytest.fixture
def conn():
    c = db.connect(":memory:")
    db.init_schema(c)
    _fill(c)        # place h1 (h1, h2, h3, named "Slavnik"), place b1 (fallback name), route r1 (r1, r2)
    refresh(c)
    c.commit()
    yield c
    c.close()


def _overrides(conn):
    return {(r[0], r[1]): (r[2], r[3]) for r in conn.execute("SELECT * FROM group_overrides")}


def test_name_place_then_refresh_uses_it(conn):
    activity_cli.name_group(conn, "place", "h1", "Moj hrib")
    activity_cli.name_group(conn, "route", "r1", "Track loop")
    assert _overrides(conn) == {("place", "h1"): ("Moj hrib", None), ("route", "r1"): ("Track loop", None)}
    refresh(conn)
    assert _rows(conn, "places")["h1"][:2] == ("Moj hrib", "owner")
    assert _rows(conn, "route_groups")["r1"] == ("Track loop", "owner")


def test_empty_name_clears(conn):
    activity_cli.name_group(conn, "place", "h1", "Moj hrib")
    refresh(conn)
    activity_cli.name_group(conn, "place", "h1", "")
    assert _overrides(conn) == {}
    refresh(conn)
    assert _rows(conn, "places")["h1"][:2] == ("Slavnik", "activity_names")

    # a row that still carries a merge keeps it; it goes once it has neither
    activity_cli.name_group(conn, "place", "b1", "Grmada")
    activity_cli.merge_place(conn, "b1", "h1")
    activity_cli.unmerge_place(conn, "b1")
    assert _overrides(conn) == {("place", "b1"): ("Grmada", None)}
    activity_cli.merge_place(conn, "b1", "h1")
    activity_cli.name_group(conn, "place", "b1", "")
    assert _overrides(conn) == {("place", "b1"): (None, "h1")}
    activity_cli.unmerge_place(conn, "b1")
    assert _overrides(conn) == {}


def test_orphaned_name_can_be_cleared(conn):
    activity_cli.name_group(conn, "place", "h1", "Moj hrib")
    refresh(conn)
    conn.execute("UPDATE activities SET visible = 0 WHERE id = 'h1'")
    assert refresh(conn)["orphaned_overrides"] == ["place h1"]
    assert "h1" not in _rows(conn, "places")
    with pytest.raises(ValueError):
        activity_cli.name_group(conn, "place", "h1", "Still mine")   # no place h1 to name any more
    activity_cli.name_group(conn, "place", "h1", "")
    assert _overrides(conn) == {}
    assert refresh(conn)["orphaned_overrides"] == []


def test_naming_a_merged_place_names_the_target(conn):
    activity_cli.merge_place(conn, "b1", "h1")
    with pytest.raises(ValueError, match="place b1 is merged into h1; name h1 instead"):
        activity_cli.name_group(conn, "place", "b1", "X")
    refresh(conn)
    with pytest.raises(ValueError, match="name h1 instead"):
        activity_cli.name_group(conn, "place", "b1", "X")


def test_merge_place_moves_activities_and_refuses_cycles(conn):
    with pytest.raises(ValueError, match="itself"):
        activity_cli.merge_place(conn, "h1", "h1")
    with pytest.raises(ValueError, match="no place r1"):
        activity_cli.merge_place(conn, "b1", "r1")
    with pytest.raises(ValueError, match="no place nope"):
        activity_cli.merge_place(conn, "nope", "h1")
    activity_cli.merge_place(conn, "b1", "h1")
    with pytest.raises(ValueError, match="cycle"):       # b1 is still in places until the refresh
        activity_cli.merge_place(conn, "h1", "b1")
    assert _overrides(conn) == {("place", "b1"): (None, "h1")}
    result = refresh(conn)
    assert result["places"] == 1 and result["orphaned_overrides"] == []
    assert "b1" not in _rows(conn, "places")
    assert _rows(conn, "activity_groups")["b1"] == ("h1", None)


def test_unmerge_works_on_orphaned_merge(conn):
    activity_cli.merge_place(conn, "b1", "h1")
    refresh(conn)
    conn.execute("UPDATE activities SET visible = 0 WHERE id IN ('h1', 'h2', 'h3')")
    assert refresh(conn)["orphaned_overrides"] == ["place b1"]
    activity_cli.unmerge_place(conn, "b1")
    assert _overrides(conn) == {}
    result = refresh(conn)
    assert result["orphaned_overrides"] == [] and set(_rows(conn, "places")) == {"b1"}


def test_unknown_group_raises(conn):
    for call in (lambda: activity_cli.name_group(conn, "place", "nope", "X"),
                 lambda: activity_cli.name_group(conn, "place", "nope", ""),
                 lambda: activity_cli.name_group(conn, "route", "h1", "X"),     # a place, not a route
                 lambda: activity_cli.name_group(conn, "route", "h1", ""),
                 lambda: activity_cli.name_group(conn, "trail", "h1", "X"),
                 lambda: activity_cli.unmerge_place(conn, "nope"),
                 lambda: activity_cli.unmerge_place(conn, "h1")):              # a place with no merge
        with pytest.raises(ValueError):
            call()
    assert _overrides(conn) == {}


def test_list_places_fallback_first(conn):
    places = activity_cli.list_places(conn)
    assert [p["id"] for p in places] == ["b1", "h1"]      # b1 has the fallback name, h1 more activities
    assert places[0]["name_source"] == "fallback" and places[0]["count"] == 1
    assert places[1] == {"id": "h1", "name": "Slavnik", "name_source": "activity_names", "kind": "peak",
                         "ele": 1028.0, "count": 3}


def test_list_routes_uses_local_dates(conn):
    # 23:30 UTC on 7 June is 8 June at UTC+1
    insert_activity(conn, "r3", "Run", "2025-06-07T23:30:00+00:00", _loop_from(offset([A], 10, -5000)[0]),
                    alts=climb_alts(N, 10))
    refresh(conn)
    [route] = activity_cli.list_routes(conn)
    assert route == {"id": "r1", "type": "Run", "name": route["name"], "name_source": "auto", "count": 3,
                     "first": "2025-06-05", "last": "2025-06-08"}


def test_cli_name_place_then_list(tmp_path, monkeypatch, capsys):
    path = build_db(tmp_path)
    monkeypatch.setattr(sys, "argv", ["activity", "places", "--db", path])
    activity_cli.main()             # the run's refresh fills the group tables before they are listed
    assert any(ln.startswith("h1 ") and "Slavnik" in ln for ln in capsys.readouterr().out.splitlines())
    monkeypatch.setattr(sys, "argv", ["activity", "name-place", "h1", "Moj hrib", "--db", path])
    activity_cli.main()
    assert 'place h1 named "Moj hrib"' in capsys.readouterr().out
    monkeypatch.setattr(sys, "argv", ["activity", "places", "--db", path])
    activity_cli.main()
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].split() == ["id", "name", "name_source", "kind", "ele", "count"]
    row = next(ln for ln in lines if ln.startswith("h1 "))
    assert "Moj hrib" in row and "owner" in row       # the run's refresh applied the name
    assert lines[0].index("name_source") == row.index("owner")    # columns line up
    monkeypatch.setattr(sys, "argv", ["activity", "routes", "--db", path])
    activity_cli.main()
    lines = capsys.readouterr().out.splitlines()
    assert lines[0].split() == ["id", "type", "name", "name_source", "count", "first", "last"]
    assert lines[1].startswith("r1 ") and lines[0].index("first") == lines[1].index("2025-06-05")
