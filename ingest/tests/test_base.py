import gzip
import io
from datetime import datetime, timezone

import pytest

from ingest.base import BaseImporter
from ingest.model import RawActivity
from ingest import store


class _Imp(BaseImporter):
    source = "strava"

    def __init__(self, db_path, items):
        super().__init__(db_path)
        self._items = items

    def activities(self):
        yield from self._items


def _raw(sid, t):
    return RawActivity(source="strava", source_id=sid, name="n", type_raw="Run",
                       start_time=t, distance_m=100.0, moving_time_s=1000,
                       elevation_gain_m=0.0, track=[(46.0, 14.0), (46.01, 14.01)])


def test_run_inserts_then_idempotent_update(tmp_path):
    db = str(tmp_path / "a.sqlite")
    t = datetime(2026, 8, 1, 6, 30, tzinfo=timezone.utc)
    c1 = _Imp(db, [_raw("1", t), _raw("2", t.replace(hour=9))]).run()
    assert c1["insert"] == 2
    c2 = _Imp(db, [_raw("1", t)]).run()
    assert c2["update"] == 1
    conn = store.connect(db)
    assert len(store.all_activities(conn)) == 2


def test_open_activity_file_gunzips(tmp_path):
    p = tmp_path / "x.gpx.gz"
    p.write_bytes(gzip.compress(b"<gpx/>"))
    name, fo = _Imp(str(tmp_path / "d.sqlite"), []).open_activity_file(str(p))
    try:
        assert name.endswith(".gpx") and not name.endswith(".gz")
        assert fo.read() == b"<gpx/>"
    finally:
        fo.close()


def test_parse_file_rejects_unknown_extension(tmp_path):
    with pytest.raises(ValueError):
        _Imp(str(tmp_path / "d.sqlite"), []).parse_file("x.csv", io.BytesIO(b""))


def test_fetcher_exits_without_creds(tmp_path, monkeypatch):
    from ingest.garmin_fetch import GarminFetcher
    monkeypatch.delenv("GARMIN_TOKEN", raising=False)
    monkeypatch.delenv("GARMINTOKENS", raising=False)
    with pytest.raises(SystemExit) as exc:
        list(GarminFetcher(str(tmp_path / "d.sqlite")).activities())
    assert exc.value.code == 2
