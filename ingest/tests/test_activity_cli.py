import re
import sys
import warnings

import pytest

from ingest import activity_cli, db
from ingest.archive import LocalArchive
from ingest.garmin_import import GarminImporter
from ingest.strava_import import StravaImporter
from ingest.tests.factories import NOW, fresh, src
from ingest.tests.test_garmin_import import _garmin_zip
from ingest.tests.test_rebuild import _imported
from ingest.tests.test_strava_import import HEADER, _row, _zip
from ingest import matcher

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
