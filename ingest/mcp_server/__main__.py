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
    # Only a missing database is fetched before serving: a slow R2 must not hold
    # up the client's start-up. Otherwise the first tool call checks R2.
    if not args.no_sync and not os.path.exists(path):
        syncer.maybe_sync(force=True)
        print(f"activity-atlas MCP: sync {syncer.last_outcome}", file=sys.stderr)
    if not os.path.exists(path):
        print(f"activity-atlas MCP: no database at {path} (and none could be synced: {syncer.last_outcome})",
              file=sys.stderr)
        raise SystemExit(2)

    ctx = ServerContext(db=Database(path), syncer=syncer,
                        places=PlaceFinder(os.path.join(os.path.dirname(path), "mcp", "places.json")))
    build_server(ctx).run("stdio")


if __name__ == "__main__":
    main()
