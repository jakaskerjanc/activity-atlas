"""Rebuild the database from the archive. Only the identity columns of
activity_sources and the activity_overrides rows are carried over from the
current database; everything else is re-derived, so activity IDs never
change. Records without an identity row go through the matcher as new."""
import argparse
import os
import warnings

from . import db, engine
from .archive import Archive, open_archive
from .export_reader import now_iso
from .records import latest

_KEPT_SOURCE_COLS = ("provider", "provider_activity_id", "activity_id", "pinned", "deleted_at", "first_seen")


def _kept_state(db_path: str):
    if not os.path.exists(db_path):
        return [], []
    conn = db.connect(db_path)
    try:
        sources = [tuple(r) for r in conn.execute(
            f"SELECT {','.join(_KEPT_SOURCE_COLS)} FROM activity_sources")]
        overrides = [tuple(r) for r in conn.execute("SELECT activity_id, hidden FROM activity_overrides")]
    finally:
        conn.close()
    return sources, overrides


def rebuild(db_path: str, archive: Archive, *, now: str, force: bool = False) -> dict[str, int]:
    """Kept source rows with no record in the archive would lose all their
    data (a wrong or empty archive path wipes every activity), so the rebuild
    stops before touching the database unless ``force`` is set."""
    sources, overrides = _kept_state(db_path)
    records = latest(archive.list_records())
    have = {(r.provider, r.provider_activity_id) for r in records}
    orphans = [s for s in sources if (s[0], s[1]) not in have]
    if orphans:
        msg = f"{len(orphans)} kept source rows have no record in the archive"
        if not force:
            raise SystemExit(f"rebuild: {msg}; check the archive path, or pass --force to keep "
                             "their identity without data")
        warnings.warn(f"{msg}; their identity is kept but they carry no data")
    tmp = db_path + ".rebuild"
    if os.path.exists(tmp):
        os.remove(tmp)
    conn = db.connect(tmp)
    try:
        db.init_schema(conn)
        conn.executemany(
            f"INSERT INTO activity_sources ({','.join(_KEPT_SOURCE_COLS)}) "
            f"VALUES ({','.join('?' * len(_KEPT_SOURCE_COLS))})", sources)
        conn.executemany("INSERT INTO activity_overrides (activity_id, hidden) VALUES (?, ?)", overrides)
        counts = engine.apply_records(conn, archive, records, now=now)
        conn.commit()
    finally:
        conn.close()
    os.replace(tmp, db_path)
    return counts


def main():
    ap = argparse.ArgumentParser(description="Rebuild the database from the archive, keeping activity IDs.")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    ap.add_argument("--force", action="store_true",
                    help="rebuild even if some activities have no record in the archive (they lose their data)")
    args = ap.parse_args()
    print(f"rebuild: {rebuild(args.db, open_archive(args.archive), now=now_iso(), force=args.force)}")


if __name__ == "__main__":
    main()
