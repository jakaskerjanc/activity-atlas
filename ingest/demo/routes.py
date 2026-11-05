"""One-off: fetch the demo's base routes and write data/demo/routes.json.

Each route is a list of waypoints around Maribor, routed along OpenStreetMap
paths by the public FOSSGIS OSRM server (routing.openstreetmap.de), then
densified to at most 50 m between points. Elevations come from Open-Meteo's
elevation API (Copernicus DEM GLO-90), sampled every 150 m along the route
and interpolated between: Open-Meteo counts every location as a call (600 a
minute, 10,000 a day), and the DEM's 90 m cells hold no finer detail anyway.
The demo build (``ingest.demo.build``) reads only the JSON, so it needs no
network.

Usage policy, as for build:cities: one request at a time, at least 1 s apart
(Open-Meteo: paced to stay under 600 locations a minute), an identifying
User-Agent, and only as an occasional one-off run.

    python -m ingest.demo.routes [--out data/demo/routes.json]
"""
import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "activity-atlas-demo (https://github.com/jakaskerjanc/activity-atlas)"
OSRM = "https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/{coords}"
ELEVATION = "https://api.open-meteo.com/v1/elevation"
STEP_M = 50.0
ELEVATION_STEP_M = 150.0
ELEVATION_BATCH = 100
LOCATIONS_PER_MINUTE = 500

# Waypoints (lat, lon). A loop ends where it starts; an out-and-back lists the
# way back explicitly. `kind` says which demo activities may use the route.
CENTER = (46.5576, 15.6455)
CABLE_CAR = (46.5340, 15.6030)
ROUTES = [
    # Runs
    {"key": "drava-loop", "name": "Drava riverside loop", "kind": "Run", "profile": "foot",
     "points": [CENTER, (46.5600, 15.6330), (46.5560, 15.6320), (46.5530, 15.6560),
                (46.5555, 15.6560), CENTER]},
    {"key": "kalvarija", "name": "Piramida and Kalvarija", "kind": "Run", "profile": "foot",
     "points": [CENTER, (46.5620, 15.6420), (46.5680, 15.6270), (46.5680, 15.6440), CENTER]},
    {"key": "park", "name": "City park laps", "kind": "Run", "profile": "foot",
     "points": [(46.5640, 15.6470), (46.5700, 15.6450), (46.5720, 15.6390), (46.5640, 15.6470)]},
    {"key": "otok", "name": "Out to Kamnica", "kind": "Run", "profile": "foot",
     "points": [(46.5590, 15.6400), (46.5650, 15.6110), (46.5730, 15.6000),
                (46.5650, 15.6110), (46.5590, 15.6400)]},
    {"key": "pohorje-trail", "name": "Pohorje trail run", "kind": "Run", "profile": "foot",
     "points": [CABLE_CAR, (46.5225, 15.5925), (46.5165, 15.5720), (46.5250, 15.5800), CABLE_CAR]},
    {"key": "tezno", "name": "Tezno flat loop", "kind": "Run", "profile": "foot",
     "points": [(46.5450, 15.6640), (46.5310, 15.6720), (46.5250, 15.6550), (46.5450, 15.6640)]},
    # Rides
    {"key": "ruse", "name": "Ruše and Fala", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.5530, 15.5880), (46.5390, 15.5150), (46.5480, 15.4500),
                (46.5520, 15.4930), (46.5730, 15.6000), CENTER]},
    {"key": "gorice", "name": "Slovenske gorice hills", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.5650, 15.6950), (46.5760, 15.8310), (46.6560, 15.6750),
                (46.6070, 15.6770), CENTER]},
    {"key": "ptuj", "name": "Ptuj loop", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.5040, 15.6970), (46.4720, 15.7680), (46.4200, 15.8700),
                (46.4130, 15.8410), (46.3970, 15.6630), (46.4500, 15.6340), (46.4990, 15.6460), CENTER]},
    {"key": "areh", "name": "Climb to Areh", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.4990, 15.6460), (46.4930, 15.5550), (46.5225, 15.5925), CABLE_CAR, CENTER]},
    {"key": "bistrica", "name": "Slovenska Bistrica loop", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.4990, 15.6460), (46.4500, 15.6340), (46.3920, 15.5740),
                (46.3970, 15.6630), (46.5040, 15.6970), CENTER]},
    {"key": "city", "name": "City spin", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.5310, 15.6720), (46.5450, 15.6640), (46.5520, 15.6230),
                (46.5730, 15.6000), CENTER]},
    {"key": "dravograd", "name": "Drava valley to Dravograd", "kind": "Ride", "profile": "bike",
     "points": [CENTER, (46.5390, 15.5150), (46.5480, 15.4500), (46.6150, 15.2250), (46.5890, 15.0210),
                (46.6150, 15.2250), (46.5480, 15.4500), (46.5390, 15.5150), CENTER]},
    # Hikes
    {"key": "pohorje-huts", "name": "Pohorje huts", "kind": "Hike", "profile": "foot",
     "points": [CABLE_CAR, (46.5165, 15.5720), (46.4930, 15.5550), (46.5100, 15.6000), CABLE_CAR]},
    {"key": "meljski", "name": "Meljski hrib", "kind": "Hike", "profile": "foot",
     "points": [CENTER, (46.5700, 15.6580), (46.5850, 15.6500), (46.5680, 15.6270), CENTER]},
    {"key": "ruse-forest", "name": "Forest above Ruše", "kind": "Hike", "profile": "foot",
     "points": [(46.5390, 15.5150), (46.5150, 15.5050), (46.5050, 15.5300), (46.5390, 15.5150)]},
    {"key": "kamnica-vineyards", "name": "Kamnica vineyards", "kind": "Hike", "profile": "foot",
     "points": [(46.5730, 15.6000), (46.5980, 15.6110), (46.6100, 15.6300), (46.5850, 15.6500),
                (46.5730, 15.6000)]},
    # Walks
    {"key": "lent", "name": "Lent and the old bridge", "kind": "Walk", "profile": "foot",
     "points": [CENTER, (46.5565, 15.6425), (46.5568, 15.6475), (46.5540, 15.6480), CENTER]},
    {"key": "park-walk", "name": "Three ponds", "kind": "Walk", "profile": "foot",
     "points": [(46.5640, 15.6470), (46.5690, 15.6450), (46.5660, 15.6400), (46.5640, 15.6470)]},
]

_next_request = 0.0


def _get(url: str, *, cost: int = 1) -> dict:
    """GET JSON at least 1 s after the previous request (cost locations at
    LOCATIONS_PER_MINUTE), waiting out a 429 up to 3 times."""
    global _next_request
    for attempt in range(4):
        wait = _next_request - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _next_request = time.monotonic() + max(1.0, cost * 60 / LOCATIONS_PER_MINUTE)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 3:
                raise
            retry = float(e.headers.get("Retry-After") or 60)
            print(f"429, waiting {retry:.0f} s", file=sys.stderr)
            _next_request = time.monotonic() + retry
    raise AssertionError("unreachable")


def haversine_m(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def densify(points: list[tuple[float, float]], step_m: float = STEP_M) -> list[tuple[float, float]]:
    """Keep every point, adding evenly spaced ones so no gap exceeds step_m.
    Consecutive duplicates are dropped."""
    out = [points[0]]
    for b in points[1:]:
        a = out[-1]
        d = haversine_m(a, b)
        if d == 0:
            continue
        n = math.ceil(d / step_m)
        for i in range(1, n + 1):
            f = i / n
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def route_geometry(profile: str, points) -> list[tuple[float, float]]:
    coords = ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in points)
    url = OSRM.format(profile=profile, coords=coords) + "?overview=full&geometries=geojson"
    data = _get(url)
    if data.get("code") != "Ok":
        raise RuntimeError(f"OSRM {profile}: {data.get('code')} {data.get('message')}")
    return [(lat, lon) for lon, lat in data["routes"][0]["geometry"]["coordinates"]]


def _fetch_elevations(points) -> list[float]:
    out = []
    for i in range(0, len(points), ELEVATION_BATCH):
        batch = points[i:i + ELEVATION_BATCH]
        q = urllib.parse.urlencode({"latitude": ",".join(f"{p[0]:.5f}" for p in batch),
                                    "longitude": ",".join(f"{p[1]:.5f}" for p in batch)})
        out.extend(_get(f"{ELEVATION}?{q}", cost=len(batch))["elevation"])
    return out


def elevations(points, fetch=_fetch_elevations) -> list[float]:
    """Elevation of every point: fetched at points about ELEVATION_STEP_M
    apart (always including the last), linearly interpolated by distance."""
    dist = [0.0]
    for a, b in zip(points, points[1:]):
        dist.append(dist[-1] + haversine_m(a, b))
    picks, next_at = [], 0.0
    for i, d in enumerate(dist):
        if d >= next_at or i == len(points) - 1:
            picks.append(i)
            next_at = d + ELEVATION_STEP_M
    known = fetch([points[i] for i in picks])
    out = []
    j = 0
    for i, d in enumerate(dist):
        while j + 1 < len(picks) and picks[j + 1] <= i:
            j += 1
        if j + 1 == len(picks) or dist[picks[j + 1]] == dist[picks[j]]:
            out.append(known[j])
        else:
            f = (d - dist[picks[j]]) / (dist[picks[j + 1]] - dist[picks[j]])
            out.append(known[j] + (known[j + 1] - known[j]) * f)
    return out


def write(out: str, routes: list[dict]) -> None:
    doc = {"v": 1,
           "source": "OSRM (OpenStreetMap, ODbL) + Open-Meteo elevation (Copernicus DEM GLO-90)",
           "routes": routes}
    with open(out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
        f.write("\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="data/demo/routes.json")
    ap.add_argument("--refresh", action="store_true", help="refetch routes already in --out")
    args = ap.parse_args()
    have = {}
    if not args.refresh:
        try:
            with open(args.out) as f:
                have = {r["key"]: r for r in json.load(f)["routes"]}
        except (OSError, KeyError, ValueError):
            pass
    routes = []
    for r in ROUTES:
        if r["key"] in have:
            print(f"{r['key']:>18}: kept from {args.out}", file=sys.stderr)
            routes.append(have[r["key"]])
            continue
        geom = densify(route_geometry(r["profile"], r["points"]))
        length = sum(haversine_m(a, b) for a, b in zip(geom, geom[1:]))
        print(f"{r['key']:>18}: {length / 1000:6.1f} km, {len(geom):5d} points, fetching elevation",
              file=sys.stderr)
        ele = elevations(geom)
        gain = sum(max(0.0, b - a) for a, b in zip(ele, ele[1:]))
        routes.append({"key": r["key"], "name": r["name"], "kind": r["kind"],
                       "points": [[round(p[0], 5), round(p[1], 5), round(e, 1)] for p, e in zip(geom, ele)]})
        write(args.out, routes)   # keep progress if the next route fails
        print(f"{'':>18}  ~{gain:.0f} m up; wrote {len(routes)} routes", file=sys.stderr)
    write(args.out, routes)
    print(f"wrote {len(routes)} routes to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
