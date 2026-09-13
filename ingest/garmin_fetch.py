"""Live Garmin Connect fetch — deferred phase (see design spec). This is the
architecture slot: a Source that feeds the same normalize/dedupe/store core."""
from .base import BaseFetcher


class GarminFetcher(BaseFetcher):
    source = "garmin"

    def activities(self):
        raise NotImplementedError("garmin_fetch is a later phase; see design spec")


def main():
    raise SystemExit("garmin_fetch not yet implemented")


if __name__ == "__main__":
    main()
