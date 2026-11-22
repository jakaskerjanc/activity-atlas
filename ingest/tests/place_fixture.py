"""Activities around Jesenice, Bled, Ljubljana and Vršič, added to the MCP fixture for the geo and
search tests. Tracks are synthetic straight lines (all visible, gain NULL).

- jes_hike (2025-06-01): starts 800 m north of Jesenice town (46.432, 14.062) and climbs 2.3 km north.
- jes_walk: a walk in town, over 7 km from Bled.
- far_hike (2025-05-01): its closest point is 12 km south of the town, nearer than hike1 (about 18 km).
- bled_walk: along the shore 500 m south of Blejsko jezero's centre (46.364, 14.094).
- lj_run1, lj_run2: runs that start 500 m and 1.5 km from Ljubljana (46.050, 14.507).
- vrsic_ride: Kranjska Gora over Prelaz Vršič (46.435, 13.744) to Trenta, about 22 km from
  Jesenice at its closest point; its name says nothing of Vršič, which only its place `vrsic1` names.
"""
import sqlite3

from ingest.tests.mcp_fixture import _insert_activity, build_fixture_db

M_PER_DEG_LAT = 111_195  # haversine's metres per degree of latitude
JES_HIKE_START = (46.4392, 14.062)
JES_HIKE_LENGTH_M = 2300  # due north


def _line(*points: tuple[float, float], n: int = 10) -> dict:
    """A track through the points, n samples per leg, one a minute."""
    lats, lons = [], []
    for (a_lat, a_lon), (b_lat, b_lon) in zip(points, points[1:]):
        for i in range(n):
            lats.append(a_lat + (b_lat - a_lat) * i / n)
            lons.append(a_lon + (b_lon - a_lon) * i / n)
    lats.append(points[-1][0])
    lons.append(points[-1][1])
    return {"time": [i * 60.0 for i in range(len(lats))], "lat": lats, "lon": lons}


def add_place_activities(conn) -> None:
    """Insert the activities above into an open fixture database; the caller commits."""
    jes_top = (JES_HIKE_START[0] + JES_HIKE_LENGTH_M / M_PER_DEG_LAT, JES_HIKE_START[1])
    _insert_activity(conn, "jes_hike", "Hike", "2025-06-01T07:00:00+00:00", name="Above Jesenice",
                     track=_line(JES_HIKE_START, jes_top))
    _insert_activity(conn, "jes_walk", "Walk", "2025-06-02T16:00:00+00:00", name="Evening in town",
                     track=_line((46.431, 14.058), (46.433, 14.066)))
    far = 46.432 - 12_000 / M_PER_DEG_LAT
    _insert_activity(conn, "far_hike", "Hike", "2025-05-01T07:00:00+00:00", name="Pokljuka edge",
                     track=_line((far, 14.062), (far - 0.02, 14.07)))
    bled = 46.364 - 500 / M_PER_DEG_LAT
    _insert_activity(conn, "bled_walk", "Walk", "2025-04-12T15:00:00+00:00", name="Lakeside stroll",
                     track=_line((bled, 14.088), (bled, 14.100)))
    _insert_activity(conn, "lj_run1", "Run", "2025-04-02T06:00:00+00:00", name="Tivoli",
                     track=_line((46.050 + 500 / M_PER_DEG_LAT, 14.507), (46.06, 14.49)))
    _insert_activity(conn, "lj_run2", "Run", "2025-04-04T06:00:00+00:00", name="Along the river",
                     track=_line((46.050 - 1500 / M_PER_DEG_LAT, 14.507), (46.03, 14.53)))
    _insert_activity(conn, "vrsic_ride", "Ride", "2025-07-05T07:00:00+00:00", name="Kranjska Gora to Trenta",
                     track=_line((46.485, 13.785), (46.435, 13.744), (46.395, 13.752)))
    conn.execute("INSERT INTO places (id, name, name_source, kind, ele) "
                 "VALUES ('vrsic1', 'Prelaz Vršič', 'osm', 'pass', 1611)")
    conn.execute("INSERT INTO activity_groups (activity_id, place_id, route_id) VALUES ('vrsic_ride', 'vrsic1', NULL)")


def build_place_db(path: str) -> str:
    """The MCP fixture plus the activities above, written before Database builds its text table."""
    build_fixture_db(path)
    conn = sqlite3.connect(path)
    add_place_activities(conn)
    conn.commit()
    conn.close()
    return path


def _nominatim(name: str, display_name: str, category: str, type_: str, addresstype: str, lat: float, lon: float,
               half_deg: float, extratags: dict) -> dict:
    """One /search?format=jsonv2&extratags=1 result, with numbers as strings the way Nominatim sends them."""
    box = [lat - half_deg, lat + half_deg, lon - half_deg, lon + half_deg]
    return {"name": name, "display_name": display_name, "category": category, "type": type_,
            "addresstype": addresstype, "lat": f"{lat:.7f}", "lon": f"{lon:.7f}",
            "boundingbox": [f"{x:.7f}" for x in box], "extratags": extratags}


# Shaped like what Nominatim returned on 2026-11-22 for these names, cut to find_place's limit of 5:
# the same fields, kinds and order (for Jesenice the SI municipality, the SI town, then Czech places; for
# Vršič peaks of that name, none of them the pass).
# Coordinates, boxes and extratags are close, not copied; the places the tests use match the activities
# above.
NOMINATIM: dict[str, list[dict]] = {
    "jesenice": [
        _nominatim("Jesenice", "Jesenice, Slovenija", "boundary", "administrative", "municipality",
                   46.446, 14.051, 0.05, {"wikipedia": "sl:Občina Jesenice"}),
        _nominatim("Jesenice", "Jesenice, Upravna enota Jesenice, Slovenija", "place", "town", "town",
                   46.432, 14.062, 0.02, {"wikipedia": "sl:Jesenice"}),
        _nominatim("Jesenice", "Jesenice, okres Praha-západ, Středočeský kraj, Střední Čechy, Česko", "place",
                   "town", "town", 49.968, 14.513, 0.02, {}),
        _nominatim("Jesenice", "Jesenice, okres Rakovník, Středočeský kraj, Střední Čechy, Česko", "place",
                   "town", "town", 50.096, 13.470, 0.02, {}),
        _nominatim("Jesenice", "Jesenice, okres Příbram, Středočeský kraj, Střední Čechy, Česko", "place",
                   "village", "village", 49.610, 14.468, 0.01, {}),
    ],
    "lake bled": [
        _nominatim("Blejsko jezero", "Blejsko jezero, Bled, Upravna enota Radovljica, Slovenija", "water", "lake",
                   "water", 46.364, 14.094, 0.008, {"ele": "475", "wikipedia": "sl:Blejsko jezero"}),
    ],
    "ljubljana": [
        _nominatim("Ljubljana", "Ljubljana, Upravna enota Ljubljana, Slovenija", "place", "city", "city",
                   46.050, 14.507, 0.08, {"capital": "yes", "wikipedia": "sl:Ljubljana"}),
        _nominatim("Ljubljana", "Ljubljana, Upravna enota Ljubljana, Slovenija", "boundary", "administrative",
                   "municipality", 46.060, 14.520, 0.12, {"wikipedia": "sl:Mestna občina Ljubljana"}),
    ],
    "vršič": [
        _nominatim("Vršič", "Vršič, Občina Bovec, Slovenija", "natural", "peak", "peak",
                   46.376, 13.634, 0.001, {"ele": "1897"}),
        _nominatim("Vršič", "Vršič, Občina Kobarid, Slovenija", "natural", "peak", "peak",
                   46.230, 13.640, 0.001, {"ele": "1323"}),
        _nominatim("Vršič", "Vršič, Občina Tolmin, Slovenija", "natural", "peak", "peak",
                   46.196, 13.812, 0.001, {"ele": "1194"}),
        _nominatim("Vršič", "Vršič, Občina Cerkno, Slovenija", "natural", "peak", "peak",
                   46.141, 13.957, 0.001, {"ele": "1034"}),
        _nominatim("Vršič", "Vršič, Občina Idrija, Slovenija", "natural", "peak", "peak",
                   45.995, 14.041, 0.001, {"ele": "892"}),
    ],
}

calls: list[dict] = []  # the params of every fetch, in order


def fetch(url: str, params: dict) -> list[dict]:
    """A Nominatim stand-in for PlaceFinder: the mock bodies above, and [] for any other name."""
    calls.append(params)
    return NOMINATIM.get(params["q"].lower(), [])
