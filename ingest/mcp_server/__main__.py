"""Run the MCP server over stdio: ``python -m ingest.mcp_server --db PATH``.

stdout carries the MCP protocol; everything else goes to stderr.
"""
import argparse
import os
import sys

from ingest.objstore import store_from_env

from .database import Database
from .freshness import Syncer
from .places import PlaceFinder
from .server import ServerContext, build_server


def main() -> None:
    ap = argparse.ArgumentParser(description="Read-only MCP server over the activity database.")
    ap.add_argument("--db", required=True, help="path to activities.sqlite (synced from R2 when configured)")
    ap.add_argument("--no-sync", action="store_true", help="do not check R2 on start")
    args = ap.parse_args()
    path = os.path.abspath(args.db)

    syncer = Syncer(path, store_from_env(read_only=True))
    if not os.path.exists(path) and (args.no_sync or syncer.store is None):
        reason = "--no-sync" if args.no_sync else "no R2 configured"
        print(f"activity-atlas MCP: no database at {path} ({reason})", file=sys.stderr)
        raise SystemExit(2)
    # A slow R2 must not hold up the client's start-up, not even without a database:
    # R2 is checked on a background thread, and until a missing database is in,
    # every tool says it is downloading and how far it got.
    db = Database(path) if os.path.exists(path) else None
    if db is None:
        print(f"activity-atlas MCP: no database at {path}; downloading it from R2", file=sys.stderr)
    ctx = ServerContext(db=db, syncer=syncer,
                        places=PlaceFinder(os.path.join(os.path.dirname(path), "mcp", "places.json")))
    if not args.no_sync:
        syncer.start(force=True)  # in the background: tools answer from the local copy meanwhile
    try:
        build_server(ctx).run("stdio")
    finally:
        syncer.stop()  # an unfinished download leaves no temporary file behind


if __name__ == "__main__":
    main()
