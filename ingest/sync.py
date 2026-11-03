"""Write the database in R2 over the local copy (``pnpm sync``).

With R2 configured every writer reads and writes the R2 database and leaves
the result at ``--db`` as a convenience copy. This pulls a fresh one, for a
machine that has not run a writer lately.
"""
import argparse
import os
import sys

from . import writer
from .archive import is_remote, open_archive


def main():
    ap = argparse.ArgumentParser(description="Overwrite the local database with the one in R2.")
    ap.add_argument("--db", default="data/activities.sqlite")
    ap.add_argument("--archive", default=None, help="archive URL (default: $ARCHIVE_URL or r2://$R2_BUCKET)")
    args = ap.parse_args()
    archive = open_archive(args.archive)
    if not is_remote(archive):
        print("sync: no R2 configured (set R2_* in .env); the local database is already the master",
              file=sys.stderr)
        raise SystemExit(1)
    tmp = writer.working_copy(args.db)
    try:
        if writer.pull(archive.store, tmp) is None:
            print(f"sync: R2 has no database at {writer.DB_KEY} (nothing to sync yet)", file=sys.stderr)
            raise SystemExit(writer.EXIT_NO_REMOTE_DB)
        writer.install(tmp, args.db)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    print(f"sync: {args.db} updated from R2")


if __name__ == "__main__":
    main()
