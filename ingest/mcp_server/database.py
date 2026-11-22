"""Read-only access to the activity database for the MCP server.

Two connections to the same file, both opened ``mode=ro``:

- ``conn`` for the server's own tools, which may read every column, with the
  ``fold`` and ``words_match`` functions and the ``temp.activity_text`` table
  behind the ``text`` filter (built from the file on every open);
- ``query_conn`` for the raw ``query`` tool, locked down by an authorizer that
  allows only reads, and that returns the raw payload columns as NULL (they are
  large and can hold private notes).
"""
import os
import sqlite3
import time

from .filters import fold_name
from .textsearch import search_texts, words_match

QUERY_TIME_LIMIT_S = 10.0
DEFAULT_MAX_ROWS = 200
HARD_MAX_ROWS = 2000

BLOCKED_COLUMNS = {
    ("daily_stats", "raw"),
    ("activity_sources", "summary_json"),
    ("activity_sources", "reported"),
}

_ALLOWED_ACTIONS = {
    sqlite3.SQLITE_SELECT,
    sqlite3.SQLITE_READ,
    sqlite3.SQLITE_FUNCTION,
    sqlite3.SQLITE_RECURSIVE,
}


class QueryError(Exception):
    """A raw query was refused, failed, or ran out of time."""


_SCHEMA_TABLES = {"sqlite_master", "sqlite_schema"}


def _authorizer(tables: set[str]):
    """Allow only reads, and only from the database's own tables and its schema
    (not virtual tables such as dbstat or sqlite_dbpage, which would bypass the
    column blocking)."""
    def authorize(action, arg1, arg2, dbname, _trigger):
        if action not in _ALLOWED_ACTIONS:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_READ:
            # A CTE or subquery read (e.g. count(*) over a WITH table) has no
            # database name; every stored or virtual table has one.
            if dbname is not None and arg1 not in tables:
                return sqlite3.SQLITE_DENY
            if (arg1, arg2) in BLOCKED_COLUMNS:
                return sqlite3.SQLITE_IGNORE
        return sqlite3.SQLITE_OK
    return authorize


def _open_ro(path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)


def _fold(s: str | None) -> str | None:
    return None if s is None else fold_name(s)


def _add_text_search(conn: sqlite3.Connection) -> None:
    """The functions and TEMP table the text and name filters use. A TEMP table is the
    connection's own, so it can be written on a read-only one and ``query_conn`` cannot see it."""
    conn.create_function("fold", 1, _fold, deterministic=True)
    conn.create_function("words_match", 2, words_match, deterministic=True)
    conn.execute("CREATE TEMP TABLE activity_text (id TEXT PRIMARY KEY, folded TEXT NOT NULL) WITHOUT ROWID")
    conn.executemany("INSERT INTO temp.activity_text (id, folded) VALUES (?, ?)", search_texts(conn).items())
    conn.commit()  # never leave a read transaction open on the file


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: sqlite3.Connection
        self.query_conn: sqlite3.Connection
        self._deadline = 0.0
        self._open()

    def _file_id(self) -> tuple | None:
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            return None
        return st.st_ino, st.st_mtime_ns, st.st_size

    def changed_on_disk(self) -> bool:
        """True when another process replaced the file since it was opened (a rename
        keeps the old inode readable through open connections, so a check is needed)."""
        now = self._file_id()
        return now is not None and now != self._opened_id

    def _open(self) -> None:
        self._opened_id = self._file_id()
        self.conn = _open_ro(self.path)
        self.conn.row_factory = sqlite3.Row
        _add_text_search(self.conn)
        q = _open_ro(self.path)
        q.execute("PRAGMA query_only = ON")
        tables = {r[0] for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")}
        q.set_authorizer(_authorizer(tables | _SCHEMA_TABLES))
        q.set_progress_handler(self._over_time, 10_000)
        self.query_conn = q

    def _over_time(self) -> int:
        return int(time.monotonic() > self._deadline)

    def reopen(self) -> None:
        """Drop both connections and open the file again (after a sync replaced it)."""
        self.close()
        self._open()

    def close(self) -> None:
        for c in (getattr(self, "conn", None), getattr(self, "query_conn", None)):
            if c is not None:
                c.close()


def run_query(db: Database, sql: str, params: list | None = None, max_rows: int = DEFAULT_MAX_ROWS) -> dict:
    rules = ["read-only SQL", "daily_stats.raw, activity_sources.summary_json and "
             "activity_sources.reported read as NULL"]
    if max_rows > HARD_MAX_ROWS:
        max_rows = HARD_MAX_ROWS
        rules.append(f"max_rows capped at {HARD_MAX_ROWS}")
    max_rows = max(1, max_rows)
    db._deadline = time.monotonic() + QUERY_TIME_LIMIT_S
    try:
        cur = db.query_conn.execute(sql, params or [])
        rows = cur.fetchmany(max_rows + 1)
    except sqlite3.OperationalError as exc:
        if "interrupted" in str(exc):
            raise QueryError(f"query stopped: over the {QUERY_TIME_LIMIT_S:g} s time limit") from exc
        raise QueryError(str(exc)) from exc
    except sqlite3.Error as exc:
        raise QueryError(str(exc)) from exc
    truncated = len(rows) > max_rows
    rows = [list(r) for r in rows[:max_rows]]
    columns = [d[0] for d in cur.description] if cur.description else []
    return {
        "data": {"columns": columns, "rows": rows, "truncated": truncated},
        "counted": {"rules": rules, "included": len(rows), "excluded": {}},
    }
