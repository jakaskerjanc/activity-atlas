"""Activities around Jesenice, Bled, Ljubljana and Vršič, added to the MCP fixture for the geo and
search tests. Tracks are synthetic straight lines (all visible, gain NULL).

- jes_hike (2025-06-01): starts 800 m north of Jesenice town (46.432, 14.062) and climbs 2.3 km north.
- jes_walk: a walk in town, over 7 km from Bled.
- far_hike (2025-05-01): its closest point is 12 km south of the town, nearer than hike1 (about 18 km).
- bled_walk: along the shore 500 m south of Blejsko jezero's centre (46.364, 14.094).
- lj_run1, lj_run2: runs that start 500 m and 1.5 km from Ljubljana (46.050, 14.507).
- vrsic_ride: Kranjska Gora over Prelaz Vršič (46.435, 13.744) to Trenta, about 24 km from Jesenice;
  its name says nothing of Vršič, which only its place `vrsic1` names.
"""
from ingest.tests.mcp_fixture import _insert_activity

M_PER_DEG_LAT = 111_195  # haversine's metres per degree of latitude


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
    jes_start = (46.4392, 14.062)
    _insert_activity(conn, "jes_hike", "Hike", "2025-06-01T07:00:00+00:00", name="Above Jesenice",
                     track=_line(jes_start, (jes_start[0] + 2300 / M_PER_DEG_LAT, 14.062)))
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
