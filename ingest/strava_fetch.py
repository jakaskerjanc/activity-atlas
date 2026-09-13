"""Live Strava fetch — deferred stub (Strava polling is dead today). Kept so the
fetcher base has a second implementation slot for when/if it returns."""
from .base import BaseFetcher


class StravaFetcher(BaseFetcher):
    source = "strava"

    def activities(self):
        raise NotImplementedError("strava_fetch is a later phase; see design spec")


def main():
    raise SystemExit("strava_fetch not yet implemented")


if __name__ == "__main__":
    main()
