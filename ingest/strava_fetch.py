"""Live Strava fetch — deferred stub (Strava polling is dead today). Kept as
the slot for a second live fetcher if it returns."""


class StravaFetcher:
    source = "strava"

    def activities(self):
        raise NotImplementedError("strava_fetch is a later phase; see design spec")


def main():
    raise SystemExit("strava_fetch not yet implemented")


if __name__ == "__main__":
    main()
