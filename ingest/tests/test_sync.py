import sys

import pytest

from ingest import archive as archive_mod
from ingest import db, sync, writer
from ingest.objstore import MemoryStore


def _db_bytes(tmp_path, name, gear):
    path = str(tmp_path / name)
    conn = db.open_db(path)
    conn.execute("INSERT INTO gear (provider, name) VALUES ('strava', ?)", (gear,))
    conn.commit()
    conn.close()
    with open(path, "rb") as fh:
        return fh.read()


def _gear(path):
    conn = db.open_db(path)
    try:
        return [r[0] for r in conn.execute("SELECT name FROM gear")]
    finally:
        conn.close()


def test_sync_without_r2_exits_1(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["sync", "--db", str(tmp_path / "db.sqlite")])
    with pytest.raises(SystemExit) as exc:
        sync.main()
    assert exc.value.code == 1
    assert "sync: no R2 configured (set R2_* in .env); the local database is already the master" \
        in capsys.readouterr().err
    assert not (tmp_path / "db.sqlite").exists()


def test_sync_overwrites_local_copy(tmp_path, monkeypatch):
    store = MemoryStore()
    store.bucket = "bkt"
    store.put(writer.DB_KEY, _db_bytes(tmp_path, "remote.sqlite", "from-r2"))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("R2_BUCKET", "bkt")
    monkeypatch.setattr(archive_mod, "store_from_env", lambda: store)
    local = str(tmp_path / "local.sqlite")
    _db_bytes(tmp_path, "local.sqlite", "stale-local")
    monkeypatch.setattr(sys, "argv", ["sync", "--db", local])
    sync.main()
    assert _gear(local) == ["from-r2"]


def test_sync_without_remote_db_exits_6(tmp_path, monkeypatch, capsys):
    store = MemoryStore()
    store.bucket = "bkt"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("R2_BUCKET", "bkt")
    monkeypatch.setattr(archive_mod, "store_from_env", lambda: store)
    monkeypatch.setattr(sys, "argv", ["sync", "--db", str(tmp_path / "db.sqlite")])
    with pytest.raises(SystemExit) as exc:
        sync.main()
    assert exc.value.code == 6
    assert not (tmp_path / "db.sqlite").exists()
