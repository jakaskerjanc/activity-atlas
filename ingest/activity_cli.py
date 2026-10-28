"""Manual fixes to activity identity: merge two activities, split a source
off into its own activity, hide or unhide an activity. Merged and split
sources are pinned, and identity survives re-imports and rebuilds."""
import argparse

from . import db, matcher, merge as merging


def _require_activity(conn, activity_id: str) -> None:
    if not conn.execute("SELECT 1 FROM activities WHERE id=?", (activity_id,)).fetchone():
        raise ValueError(f"no activity {activity_id}")


def _hidden(conn, activity_id: str) -> bool:
    row = conn.execute("SELECT hidden FROM activity_overrides WHERE activity_id=?", (activity_id,)).fetchone()
    return bool(row and row["hidden"])


def _hide(conn, activity_id: str) -> None:
    conn.execute("INSERT INTO activity_overrides (activity_id, hidden) VALUES (?, 1) "
                 "ON CONFLICT(activity_id) DO UPDATE SET hidden=1", (activity_id,))


def merge(conn, keep_id: str, other_id: str) -> None:
    """Move every source of other_id to keep_id, pin them, drop other_id.
    If either activity was hidden, the merged one stays hidden."""
    if keep_id == other_id:
        raise ValueError("cannot merge an activity with itself")
    _require_activity(conn, keep_id)
    _require_activity(conn, other_id)
    if _hidden(conn, other_id):
        _hide(conn, keep_id)
    conn.execute("UPDATE activity_sources SET activity_id=? WHERE activity_id=?", (keep_id, other_id))
    conn.execute("UPDATE activity_sources SET pinned=1 WHERE activity_id=?", (keep_id,))
    for table, col in (("activities", "id"), ("activity_overrides", "activity_id"),
                       ("activity_gear", "activity_id")):
        conn.execute(f"DELETE FROM {table} WHERE {col}=?", (other_id,))
    merging.recompute_activity(conn, keep_id)


def split(conn, activity_id: str, provider: str, provider_activity_id: str) -> str:
    """Give one source its own new activity; pin the sources of both. A
    hidden activity's split-off part is hidden too. Returns the new ID."""
    row = conn.execute("SELECT 1 FROM activity_sources WHERE activity_id=? AND provider=? "
                       "AND provider_activity_id=?", (activity_id, provider, provider_activity_id)).fetchone()
    if row is None:
        raise ValueError(f"activity {activity_id} has no source {provider}:{provider_activity_id}")
    count = conn.execute("SELECT COUNT(*) FROM activity_sources WHERE activity_id=?", (activity_id,)).fetchone()[0]
    if count < 2:
        raise ValueError(f"{provider}:{provider_activity_id} is the only source of activity {activity_id}")
    new_id = matcher.new_activity_id(conn)
    conn.execute("UPDATE activity_sources SET activity_id=? WHERE provider=? AND provider_activity_id=?",
                 (new_id, provider, provider_activity_id))
    conn.execute("UPDATE activity_sources SET pinned=1 WHERE activity_id IN (?, ?)", (activity_id, new_id))
    if _hidden(conn, activity_id):
        _hide(conn, new_id)
    merging.recompute_activity(conn, activity_id)
    merging.recompute_activity(conn, new_id)
    return new_id


def set_hidden(conn, activity_id: str, hidden: bool) -> None:
    _require_activity(conn, activity_id)
    conn.execute("INSERT INTO activity_overrides (activity_id, hidden) VALUES (?, ?) "
                 "ON CONFLICT(activity_id) DO UPDATE SET hidden=excluded.hidden", (activity_id, int(hidden)))
    merging.recompute_activity(conn, activity_id)


def main():
    ap = argparse.ArgumentParser(description="Manual fixes to activities.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("merge", help="move every source of OTHER into KEEP")
    m.add_argument("keep_id")
    m.add_argument("other_id")
    s = sub.add_parser("split", help="give one source its own activity")
    s.add_argument("activity_id")
    s.add_argument("source", help="provider:provider_activity_id, e.g. garmin:123")
    for name in ("hide", "unhide"):
        sub.add_parser(name, help=f"{name} an activity on the site").add_argument("activity_id")
    for p in sub.choices.values():
        p.add_argument("--db", default="data/activities.sqlite")
    args = ap.parse_args()

    conn = db.open_db(args.db)
    try:
        if args.cmd == "merge":
            merge(conn, args.keep_id, args.other_id)
            print(f"merged {args.other_id} into {args.keep_id}")
        elif args.cmd == "split":
            provider, sep, pid = args.source.partition(":")
            if not sep or not pid:
                ap.error("source must be provider:provider_activity_id")
            print(f"split {args.source} into {split(conn, args.activity_id, provider, pid)}")
        else:
            set_hidden(conn, args.activity_id, args.cmd == "hide")
            print(f"{args.cmd} {args.activity_id}")
        conn.commit()
    except ValueError as e:
        raise SystemExit(f"activity: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
