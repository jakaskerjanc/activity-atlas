"""The demo dataset: made-up activities on real paths around Maribor, so a
fresh copy of the template has a working site before any import.

- ``routes.py`` (one-off, network): base routes from OSRM + Open-Meteo
  elevations -> ``data/demo/routes.json`` (committed).
- ``build.py`` (offline, seeded): a fake Strava export over those routes, run
  through the real Strava importer -> ``data/demo/activities.sqlite``
  (committed).
"""
