"""Bring the derived group tables (places, route_groups, activity_groups) up to date with the activities,
the OSM points and the owner's group_overrides. ``writer.run`` calls ``refresh_file`` after every write
job. Only rows that differ are written, so a refresh with nothing new leaves the file byte-identical.

The module layering keeps ``refresh`` on ``grouping``, ``naming`` and ``db``."""
import os
from collections.abc import Callable, Mapping
from typing import Any

from ingest import db, grouping, naming

NO_OSM_RADIUS_M = 10_000
_COMMAND = "pnpm run activity"


def _sync(conn, table: str, cols: tuple[str, ...], want: Mapping[str, tuple]) -> int:
    """Make ``table`` hold exactly ``want`` (key -> the other columns), with the fewest statements.
    Returns the number of rows inserted, updated or deleted. The key is the first column."""
    key, rest = cols[0], cols[1:]
    have = {r[0]: tuple(r[1:]) for r in conn.execute(f"SELECT {', '.join(cols)} FROM {table}")}
    gone = sorted(k for k in have if k not in want)
    new = sorted(k for k in want if k not in have)
    changed = sorted(k for k in want if k in have and have[k] != tuple(want[k]))
    if gone:
        conn.executemany(f"DELETE FROM {table} WHERE {key} = ?", [(k,) for k in gone])
    if new:
        conn.executemany(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                         [(k, *want[k]) for k in new])
    if changed:
        conn.executemany(f"UPDATE {table} SET {', '.join(f'{c} = ?' for c in rest)} WHERE {key} = ?",
                         [(*want[k], k) for k in changed])
    return len(gone) + len(new) + len(changed)


def _orphan_note(kind: str, gid: str, name: str | None, merge: str | None,
                 anchors: frozenset[str], routes: set[str]) -> str | None:
    """The line that reports an override pointing at nothing, with the command that clears it; else None."""
    if kind == "route" and gid not in routes:
        return (f"orphaned route override {gid}: no such route any more; "
                f'clear it with {_COMMAND} name-route {gid} ""')
    if kind != "place":
        return None
    if gid not in anchors:
        cmds = [f'{_COMMAND} name-place {gid} ""'] if name or not merge else []
        if merge:
            cmds.append(f"{_COMMAND} unmerge-place {gid}")
        return f"orphaned place override {gid}: no such place any more; clear it with {' and '.join(cmds)}"
    if merge and merge not in anchors:
        return (f"orphaned place override {gid}: merged into {merge}, which is no longer a place; "
                f"clear it with {_COMMAND} unmerge-place {gid}")
    return None


def _refresh(conn) -> tuple[dict[str, Any], list[str]]:
    skipped: list[str] = []
    tracks = grouping.load_tracks(conn, skipped)
    points = [naming.OsmPoint(*r) for r in conn.execute(
        "SELECT osm_id, kind, name, lat, lon, ele FROM osm_points ORDER BY osm_id")]
    index = naming.PointIndex(points)
    overrides = [tuple(r) for r in conn.execute(
        "SELECT kind, group_id, name, merge_into FROM group_overrides ORDER BY kind, group_id")]
    place_names = {g: n for k, g, n, _ in overrides if k == "place" and n}
    merges = {g: m for k, g, _, m in overrides if k == "place" and m}
    route_names = {g: n for k, g, n, _ in overrides if k == "route" and n}

    groups = grouping.group_activities(tracks, merges)
    places = naming.name_places(groups, tracks, index, place_names)
    routes = naming.name_routes(groups, tracks, places, index, route_names)

    members = set(groups.place_of) | set(groups.route_of)
    rows_changed = _sync(conn, "places", ("id", "name", "name_source", "kind", "ele"),
                         {p.id: (p.name, p.name_source, p.kind, p.ele) for p in places.values()})
    rows_changed += _sync(conn, "route_groups", ("id", "name", "name_source"),
                          {r.id: (r.name, r.name_source) for r in routes.values()})
    rows_changed += _sync(conn, "activity_groups", ("activity_id", "place_id", "route_id"),
                          {a: (groups.place_of.get(a), groups.route_of.get(a)) for a in members})

    highest: dict[str, Any] = {}
    for t in tracks:
        pid = groups.place_of.get(t.id)
        if pid is not None and t.top is not None and (pid not in highest or t.top.ele > highest[pid].ele):
            highest[pid] = t.top
    no_osm = sum(1 for top in highest.values()
                 if not index.near(top.lat, top.lon, NO_OSM_RADIUS_M, naming.PEAK_KINDS))

    route_ids = set(groups.route_of.values())
    orphaned, notes = [], []
    for kind, gid, name, merge in overrides:
        note = _orphan_note(kind, gid, name, merge, groups.place_anchors, route_ids)
        if note is not None:
            orphaned.append(f"{kind} {gid}")
            notes.append(note)
    if no_osm and points:
        notes.insert(0, f"{no_osm} places have no OSM data nearby; run pnpm run places:update")
    if skipped:
        notes.insert(0, f"skipped {len(skipped)} activities whose track won't decode: {', '.join(sorted(skipped))}")
    result = {"places": len(places), "routes": len(routes), "rows_changed": rows_changed,
              "no_osm_nearby": no_osm, "orphaned_overrides": orphaned}
    return result, notes


def refresh(conn) -> dict[str, Any]:
    """Recompute places, routes and their names and write the rows that differ. Doesn't commit.
    ``orphaned_overrides`` lists the group_overrides rows that point at nothing, as "{kind} {group_id}"."""
    return _refresh(conn)[0]


def refresh_file(path: str, log: Callable[[str], Any] = print) -> dict[str, Any] | None:
    """Refresh the database at ``path``, committing only when a row changed. None, touching nothing, when
    the file is missing or not a current-schema database. On an error the transaction is rolled back, so
    the file keeps its previous group tables, and the error is raised."""
    if not os.path.exists(path):
        return None
    conn = db.connect(path)
    try:
        if conn.execute("PRAGMA user_version").fetchone()[0] != db.SCHEMA_VERSION:
            return None
        result, notes = _refresh(conn)
        if result["rows_changed"]:
            conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    for note in notes:
        log(note)
    return result
