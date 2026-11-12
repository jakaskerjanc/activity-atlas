"""Manual fixes to activity identity: merge two activities, split a source
off into its own activity, hide or unhide an activity. Merged and split
sources are pinned, and identity survives re-imports and rebuilds.

Also the owner's names and merges for places and same routes, kept in
group_overrides: list them, name one, merge one place into another. The
refresh that writer.run does after every job applies them on the same run.

Listing is read-only: it reads a temporary pull of the R2 database, or the
local database in place, and never uploads or refreshes. It shows the groups
as the last write job left them."""
import argparse
import os
import sqlite3
from datetime import date

from . import db, matcher, merge as merging, writer
from .archive import is_remote, open_archive


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


GROUP_TABLES = {"place": "places", "route": "route_groups"}


def _group_exists(conn, kind: str, group_id: str) -> bool:
    if kind not in GROUP_TABLES:
        raise ValueError(f"unknown group kind {kind!r}; use place or route")
    return conn.execute(f"SELECT 1 FROM {GROUP_TABLES[kind]} WHERE id=?", (group_id,)).fetchone() is not None


def _override(conn, kind: str, group_id: str):
    return conn.execute("SELECT name, merge_into FROM group_overrides WHERE kind=? AND group_id=?",
                        (kind, group_id)).fetchone()


def _drop_if_empty(conn, kind: str, group_id: str) -> None:
    conn.execute("DELETE FROM group_overrides WHERE kind=? AND group_id=? AND name IS NULL AND merge_into IS NULL",
                 (kind, group_id))


def list_places(conn) -> list[dict]:
    """Every place with its activity count: fallback-named places first (they want a name), then by count."""
    rows = conn.execute(
        "SELECT p.id, p.name, p.name_source, p.kind, p.ele, COUNT(g.activity_id) AS count FROM places p "
        "LEFT JOIN activity_groups g ON g.place_id = p.id GROUP BY p.id "
        "ORDER BY p.name_source = 'fallback' DESC, count DESC, p.id")
    return [dict(r) for r in rows]


def list_routes(conn) -> list[dict]:
    """Every same route with its anchor's type, its activity count and its first and last local dates."""
    rows = conn.execute(
        "SELECT r.id, (SELECT type FROM activities WHERE id = r.id) AS type, r.name, r.name_source, "
        "COUNT(a.id) AS count, MIN(substr(a.start_local, 1, 10)) AS first, "
        "MAX(substr(a.start_local, 1, 10)) AS last FROM route_groups r "
        "LEFT JOIN activity_groups g ON g.route_id = r.id LEFT JOIN activities a ON a.id = g.activity_id "
        "GROUP BY r.id ORDER BY type, count DESC, r.id")
    return [dict(r) for r in rows]


def name_group(conn, kind: str, group_id: str, name: str) -> None:
    """Give a place or route the owner's name; an empty name clears it. Clearing works on any id with an
    override row, even one whose group is gone, so an orphaned name can always be cleared."""
    name = name.strip()
    exists = _group_exists(conn, kind, group_id)
    row = _override(conn, kind, group_id)
    if not name:
        if row is None:
            if not exists:
                raise ValueError(f"no {kind} {group_id}")
            return
        conn.execute("UPDATE group_overrides SET name=NULL WHERE kind=? AND group_id=?", (kind, group_id))
        _drop_if_empty(conn, kind, group_id)
        return
    if row is not None and row["merge_into"]:
        target = row["merge_into"]
        raise ValueError(f"{kind} {group_id} is merged into {target}; name {target} instead")
    if not exists:
        raise ValueError(f"no {kind} {group_id}")
    conn.execute("INSERT INTO group_overrides (kind, group_id, name) VALUES (?, ?, ?) "
                 "ON CONFLICT(kind, group_id) DO UPDATE SET name=excluded.name", (kind, group_id, name))


def merge_place(conn, place_id: str, into_id: str) -> None:
    """Fold place_id's activities into into_id. Refuses a merge that would close a cycle of merges."""
    if place_id == into_id:
        raise ValueError(f"cannot merge place {place_id} into itself")
    for pid in (place_id, into_id):
        if not _group_exists(conn, "place", pid):
            raise ValueError(f"no place {pid}")
    merges = dict(conn.execute("SELECT group_id, merge_into FROM group_overrides "
                               "WHERE kind='place' AND merge_into IS NOT NULL").fetchall())
    seen, at = set(), into_id
    while at is not None and at not in seen:
        if at == place_id:
            raise ValueError(f"place {into_id} is merged into {place_id}: merging {place_id} into it "
                             "would make a cycle")
        seen.add(at)
        at = merges.get(at)
    conn.execute("INSERT INTO group_overrides (kind, group_id, merge_into) VALUES ('place', ?, ?) "
                 "ON CONFLICT(kind, group_id) DO UPDATE SET merge_into=excluded.merge_into", (place_id, into_id))


def unmerge_place(conn, place_id: str) -> None:
    """Undo a merge, whether or not the place or its target still exists."""
    row = _override(conn, "place", place_id)
    if row is None or not row["merge_into"]:
        raise ValueError(f"place {place_id} is not merged into another place")
    conn.execute("UPDATE group_overrides SET merge_into=NULL WHERE kind='place' AND group_id=?", (place_id,))
    _drop_if_empty(conn, "place", place_id)


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def format_table(rows: list[dict], cols: tuple[str, ...]) -> str:
    """Rows as aligned columns under a header."""
    cells = [list(cols)] + [[_cell(r[c]) for c in cols] for r in rows]
    widths = [max(len(line[i]) for line in cells) for i in range(len(cols))]
    return "\n".join("  ".join(v.ljust(w) for v, w in zip(line, widths)).rstrip() for line in cells)


PLACE_COLS = ("id", "name", "name_source", "kind", "ele", "count")
ROUTE_COLS = ("id", "type", "name", "name_source", "count", "first", "last")
LIST_COMMANDS = ("places", "routes")
_GROUP_TABLES = ("places", "route_groups", "activity_groups")


def _print_list(path: str, cmd: str) -> None:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        have = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if not have.issuperset(_GROUP_TABLES):
            raise SystemExit("activity: this database has no places or routes yet; "
                             "they appear after the next write job")
        if cmd == "places":
            print(format_table(list_places(conn), PLACE_COLS))
        else:
            print(format_table(list_routes(conn), ROUTE_COLS))
    finally:
        conn.close()


def list_groups(cmd: str, db_path: str, archive) -> None:
    """Print places or routes without writing anything: from a temporary pull of the R2 database, which
    is deleted afterwards, or from ``db_path`` in place with a local archive."""
    if not is_remote(archive):
        if not os.path.exists(db_path):
            raise SystemExit(f"activity: no database at {db_path}")
        _print_list(db_path, cmd)
        return
    tmp = writer.working_copy(db_path)
    try:
        if writer.pull(archive.store, tmp) is None:
            raise SystemExit(f"activity: R2 has no database at {writer.DB_KEY}")
        _print_list(tmp, cmd)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


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
    sub.add_parser("places", help="list places, unnamed (fallback-named) ones first")
    sub.add_parser("routes", help="list same routes")
    for kind in GROUP_TABLES:
        n = sub.add_parser(f"name-{kind}", help=f'give a {kind} your own name ("" clears it)')
        n.add_argument("group_id")
        n.add_argument("name")
    mp = sub.add_parser("merge-place", help="fold place ID into place INTO")
    mp.add_argument("place_id")
    mp.add_argument("into_id")
    sub.add_parser("unmerge-place", help="undo merge-place").add_argument("place_id")
    for p in sub.choices.values():
        p.add_argument("--db", default="data/activities.sqlite")
        p.add_argument("--archive", default=None,
                       help="archive URL (default: $ARCHIVE_URL or file://data/archive)")
    args = ap.parse_args()
    if args.cmd == "split":
        provider, sep, pid = args.source.partition(":")
        if not sep or not pid:
            ap.error("source must be provider:provider_activity_id")
    if args.cmd in LIST_COMMANDS:
        list_groups(args.cmd, args.db, open_archive(args.archive))
        return

    def work(path):
        conn = db.open_db(path)
        try:
            if args.cmd == "merge":
                merge(conn, args.keep_id, args.other_id)
                message = f"merged {args.other_id} into {args.keep_id}"
            elif args.cmd == "split":
                message = f"split {args.source} into {split(conn, args.activity_id, provider, pid)}"
            elif args.cmd.startswith("name-"):
                kind = args.cmd.removeprefix("name-")
                name_group(conn, kind, args.group_id, args.name)
                message = (f'{kind} {args.group_id} named "{args.name.strip()}"' if args.name.strip()
                           else f"cleared the name of {kind} {args.group_id}")
            elif args.cmd == "merge-place":
                merge_place(conn, args.place_id, args.into_id)
                message = f"merged place {args.place_id} into {args.into_id}"
            elif args.cmd == "unmerge-place":
                unmerge_place(conn, args.place_id)
                message = f"unmerged place {args.place_id}"
            else:
                set_hidden(conn, args.activity_id, args.cmd == "hide")
                message = f"{args.cmd} {args.activity_id}"
            conn.commit()
            return message
        except ValueError as e:
            raise SystemExit(f"activity: {e}")
        finally:
            conn.close()

    # work may run again after an upload conflict, so the message is printed once, here.
    print(writer.run(args.db, open_archive(args.archive), work, today=date.today().isoformat()))


if __name__ == "__main__":
    main()
