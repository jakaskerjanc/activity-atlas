"""Build the demo database from ``data/demo/routes.json``.

Offline and deterministic: from each base route this makes a year and a bit of
made-up activities (reverse direction, pace, heart rate, cadence, power,
pauses), writes them as a fake Strava bulk export, and runs the real
``ingest.strava_import`` importer over it. The committed result,
``data/demo/activities.sqlite``, is what a fresh fork builds its
site from.

No personal data is read or written: the only input is the committed route
JSON, and the export archive lives in a temporary directory.

    python -m ingest.demo.build [--out data/demo/activities.sqlite]

Regenerating is only needed after ``ingest.demo.routes`` changes the routes or
this file changes the activity mix. The seed is fixed so the result is
reproducible.
"""
import argparse
import csv
import io
import itertools
import json
import math
import os
import random
import sys
import tempfile
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .. import db, matcher
from ..archive import LocalArchive
from ..calc import elevation_gain_loss
from ..strava_import import StravaImporter
from .routes import haversine_m

SEED = 20261102
NOW = "2026-11-05T12:00:00+00:00"
EXPORT_TIME = (2026, 11, 5, 12, 0, 0)
FIRST_DAY = date(2025, 8, 1)
LAST_DAY = date(2026, 11, 4)

# How many activities of each type the full demo has. Routes rotate in order,
# so every base route is used about equally.
COUNTS = {"Run": 42, "Ride": 34, "Hike": 18, "Walk": 10, "WeightTraining": 4}

# Base pace (m/s at grade 0), how hard a climb slows it, heart rate, and
# cadence. A ride also gets power.
PROFILE = {
    "Run": {"speed": 2.90, "grade": 4.2, "hr": 147, "cadence": 170},
    "Ride": {"speed": 7.30, "grade": 5.4, "hr": 137, "cadence": 86, "power": True},
    "Hike": {"speed": 1.28, "grade": 4.6, "hr": 120, "cadence": None},
    "Walk": {"speed": 1.38, "grade": 3.6, "hr": 104, "cadence": None},
}

FLAVORS = {
    "Run": ["Morning run", "Easy run", "Evening run", "Tempo run", "Riverside run", "Weekend run"],
    "Ride": ["Morning ride", "After-work ride", "Weekend ride", "Easy spin", "Long ride", "Hill ride"],
    "Hike": ["Morning hike", "Sunday hike", "Forest hike", "Afternoon hike"],
    "Walk": ["Evening walk", "Sunday walk", "After-dinner walk"],
}
HOURS = {
    "Run": [(5, 8), (16, 19)],
    "Ride": [(7, 10), (16, 18)],
    "Hike": [(7, 10)],
    "Walk": [(9, 12), (17, 20)],
    "WeightTraining": [(17, 20)],
}
GEAR = {
    "Run": ["Demo trail shoes", "Demo road shoes"],
    "Ride": ["Demo road bike", "Demo gravel bike"],
    "Hike": ["Demo hiking boots"],
    "Walk": [],
    "WeightTraining": [],
}

CSV_HEADER = [
    "Activity ID", "Activity Date", "Activity Name", "Activity Type", "Elapsed Time",
    "Distance", "Moving Time", "Elevation Gain", "Elevation Loss", "Average Heart Rate",
    "Max Heart Rate", "Average Cadence", "Max Cadence", "Average Watts", "Max Watts",
    "Calories", "Activity Gear", "Filename",
]


class _DeterministicIds:
    """Replace the matcher's random activity IDs with demo000001, demo000002...
    so rebuilding the database gives the same IDs and the same git diff."""

    def __init__(self):
        self._seq = itertools.count(1)

    def __call__(self, conn) -> str:
        while True:
            aid = f"demo{next(self._seq):06d}"
            used = conn.execute(
                "SELECT 1 FROM activities WHERE id=? UNION ALL "
                "SELECT 1 FROM activity_sources WHERE activity_id=?", (aid, aid)).fetchone()
            if not used:
                return aid


def _wave(s: float, phase: float) -> float:
    """Pace/effort variation along the route: two slow sine waves, not noise."""
    return 0.06 * math.sin(s / 420 + phase) + 0.03 * math.sin(s / 130 + 2 * phase)


def _speed(kind: str, grade: float, wave: float) -> float:
    p = PROFILE[kind]
    grade = max(-0.30, min(0.30, grade))
    if grade >= 0:
        factor = 1.0 - p["grade"] * grade
    else:
        factor = 1.0 + p["grade"] * (-grade) * 0.6
    return max(0.45, p["speed"] * factor * (1.0 + wave))


def _start_times(kind: str, total: int, rng: random.Random, used: set[str]) -> list[datetime]:
    """`total` starts spread evenly over the range, with a plausible time of
    day. Hikes (and most rides) fall on a weekend. Times are UTC; the importer
    derives the local offset from the first GPS fix."""
    span = (LAST_DAY - FIRST_DAY).days
    starts = []
    for i in range(total):
        lo = FIRST_DAY + timedelta(days=round(i * span / total))
        hi = FIRST_DAY + timedelta(days=round((i + 1) * span / total))
        weekend = kind == "Hike" or (kind == "Ride" and rng.random() < 0.6)
        days = [lo + timedelta(days=k) for k in range((hi - lo).days + 1)]
        if weekend:
            days = [d for d in days if d.weekday() >= 5] or days
        day = rng.choice(days)
        hour_lo, hour_hi = rng.choice(HOURS[kind])
        start = datetime(day.year, day.month, day.day, rng.randrange(hour_lo, hour_hi),
                         rng.randrange(60), rng.randrange(60), tzinfo=timezone.utc)
        while start.isoformat() in used:
            start += timedelta(minutes=1)
        used.add(start.isoformat())
        starts.append(start)
    return starts


def _track(kind: str, route: dict, rng: random.Random):
    """(samples, stopped seconds) for one activity.

    A sample is (lat, lon, ele, t, hr, cadence, power). The route comes
    densified at 50 m from ``routes.json``; direction and a few metres of
    smooth GPS jitter make repeated visits look recorded, not copied.
    """
    pts = [(p[0], p[1], p[2]) for p in route["points"]]
    if rng.random() < 0.5:
        pts.reverse()
    dist = [0.0]
    for a, b in zip(pts, pts[1:]):
        dist.append(dist[-1] + haversine_m(a, b))

    phase = rng.uniform(0, 2 * math.pi)
    jitter = rng.uniform(0.5, 1.5)
    pauses = {}
    for _ in range(rng.choice([0, 0, 0, 1, 1, 2])):
        if len(pts) > 4:
            pauses[rng.randrange(1, len(pts))] = rng.uniform(20, 150)
    stopped = sum(pauses.values())

    p = PROFILE[kind]
    t = 0.0
    hr = p["hr"] - 22
    peak = p["hr"] + 34 + rng.uniform(-5, 5)
    out = []
    for i, (lat, lon, ele) in enumerate(pts):
        if i:
            d = max(0.05, dist[i] - dist[i - 1])
            grade = (pts[i][2] - pts[i - 1][2]) / d
            dt = d / _speed(kind, grade, _wave(dist[i], phase))
            t += dt + pauses.get(i, 0.0)
            target = min(peak, p["hr"] + 380 * max(0.0, grade)
                         - 55 * max(0.0, -grade) + 20 * _wave(dist[i], phase))
            hr += (target - hr) * (1 - math.exp(-dt / 24))
            hr = max(85.0, min(peak, hr + rng.uniform(-0.6, 0.6)))
        wave = _wave(dist[i], phase)
        # A smooth displacement of at most a few metres.
        lat += jitter * 1e-5 * math.sin(dist[i] / 190 + phase)
        lon += jitter * 1e-5 * math.cos(dist[i] / 210 + phase)
        cadence = (p["cadence"] + 7 * math.sin(dist[i] / 330 + phase)
                   + rng.uniform(-1.5, 1.5) if p["cadence"] else None)
        power = None
        if p.get("power") and i:
            grade = (pts[i][2] - pts[i - 1][2]) / max(0.05, dist[i] - dist[i - 1])
            speed = _speed(kind, grade, wave)
            power = (90 + 2.0 * speed ** 2 + 75 * 9.81 * max(0.0, grade) * speed
                     + 18 * math.sin(dist[i] / 260 + phase))
            power = max(60.0, min(450.0, power))
        out.append((lat, lon, ele + rng.uniform(-0.4, 0.4), t, hr, cadence, power))
    return out, stopped


def _xml(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _gpx(name: str, kind: str, start: datetime, track) -> bytes:
    head = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="Activity Atlas demo" '
        'xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n'
        f'<metadata><name>{_xml(name)}</name></metadata>\n'
        f'<trk><name>{_xml(name)}</name><type>{kind.lower()}</type><trkseg>\n'
    )
    body = []
    for lat, lon, ele, t, hr, cadence, power in track:
        when = (start + timedelta(seconds=t)).strftime("%Y-%m-%dT%H:%M:%SZ")
        ext = f"<gpxtpx:hr>{hr:.0f}</gpxtpx:hr>"
        if cadence is not None:
            ext += f"<gpxtpx:cad>{cadence:.0f}</gpxtpx:cad>"
        if power is not None:
            ext += f"<power>{power:.0f}</power>"
        body.append(
            f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>{ele:.1f}</ele>'
            f'<time>{when}</time><extensions>'
            f"<gpxtpx:TrackPointExtension>{ext}</gpxtpx:TrackPointExtension>"
            "</extensions></trkpt>\n")
    return (head + "".join(body) + "</trkseg></trk></gpx>\n").encode()


def _summary(kind: str, track, moving_s: float) -> dict:
    ele = [p[2] for p in track]
    gain, loss = elevation_gain_loss(ele)
    hr = [p[4] for p in track]
    cadence = [p[5] for p in track if p[5] is not None]
    power = [p[6] for p in track if p[6] is not None]
    met = {"Run": 9.8, "Ride": 7.6, "Hike": 6.2, "Walk": 3.6}.get(kind, 5.0)
    return {
        "distance": sum(haversine_m(a[:2], b[:2]) for a, b in zip(track, track[1:])),
        "elevation_gain": gain, "elevation_loss": loss,
        "avg_hr": sum(hr) / len(hr), "max_hr": max(hr),
        "avg_cadence": sum(cadence) / len(cadence) if cadence else None,
        "max_cadence": max(cadence) if cadence else None,
        "avg_power": sum(power) / len(power) if power else None,
        "max_power": max(power) if power else None,
        "calories": met * 75 * moving_s / 3600 * 1.05,
    }


def _row(pid: str, start: datetime, name: str, kind: str, elapsed_s: float, moving_s: float,
         summary: dict, gear: str, has_file: bool) -> list[str]:
    def num(value, dp=1):
        return "" if value is None else f"{value:.{dp}f}"

    return [
        pid, start.strftime("%b %d, %Y, %I:%M:%S %p"), name, kind,
        num(elapsed_s, 0), num(summary["distance"]), num(moving_s, 0),
        num(summary["elevation_gain"]), num(summary["elevation_loss"]),
        num(summary["avg_hr"], 0), num(summary["max_hr"], 0),
        num(summary["avg_cadence"], 0), num(summary["max_cadence"], 0),
        num(summary["avg_power"], 0), num(summary["max_power"], 0),
        num(summary["calories"], 0), gear,
        f"activities/{pid}.gpx" if has_file else "",
    ]


def _gym_row(pid: str, start: datetime, rng: random.Random) -> list[str]:
    elapsed = rng.randrange(35, 65) * 60
    return [pid, start.strftime("%b %d, %Y, %I:%M:%S %p"), "Gym session", "Weight Training",
            str(elapsed), "0", str(elapsed), "", "", str(rng.randrange(105, 125)),
            str(rng.randrange(135, 155)), "", "", "", "", str(rng.randrange(220, 330)), "", ""]


def build(routes_doc: dict, out: str, workdir: str, *, seed: int = SEED,
          counts: dict | None = None, now: str = NOW) -> dict:
    """Write the demo database at ``out`` and return a small summary."""
    counts = {**COUNTS, **(counts or {})}
    rng = random.Random(seed)
    used_starts: set[str] = set()
    by_kind: dict[str, list[dict]] = {}
    for route in routes_doc["routes"]:
        by_kind.setdefault(route["kind"], []).append(route)

    work = Path(workdir)
    export = work / "strava"
    (export / "activities").mkdir(parents=True, exist_ok=True)
    dated = []
    for kind, total in counts.items():
        routes = by_kind.get(kind, [])
        starts = _start_times(kind, total, rng, used_starts)
        if kind == "WeightTraining":
            dated.extend((start, kind, None) for start in starts)
        elif routes:
            dated.extend((start, kind, routes[i % len(routes)]) for i, start in enumerate(starts))
    dated.sort(key=lambda item: item[0])

    rows: list[list[str]] = []
    next_id = itertools.count(10_000_000)
    for start, kind, route in dated:
        pid = str(next(next_id))
        if route is None:
            rows.append(_gym_row(pid, start, rng))
            continue
        track, stopped = _track(kind, route, rng)
        elapsed = track[-1][3]
        moving = max(1.0, elapsed - stopped)
        summary = _summary(kind, track, moving)
        name = f"{rng.choice(FLAVORS[kind])} - {route['name']}"
        gear = rng.choice(GEAR[kind]) if GEAR[kind] else ""
        rows.append(_row(pid, start, name, kind, elapsed, moving, summary, gear, True))
        (export / "activities" / f"{pid}.gpx").write_bytes(_gpx(name, kind, start, track))

    csv_text = io.StringIO(newline="")
    writer = csv.writer(csv_text, lineterminator="\n")
    writer.writerow(CSV_HEADER)
    writer.writerows(rows)
    (export / "activities.csv").write_text(csv_text.getvalue(), encoding="utf-8")

    zip_path = work / "strava-export.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(export.rglob("*")):
            if path.is_file():
                member = path.relative_to(export).as_posix()
                zf.writestr(zipfile.ZipInfo(member, EXPORT_TIME), path.read_bytes(),
                            compress_type=zipfile.ZIP_DEFLATED)

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(str(out_path) + suffix)
        except FileNotFoundError:
            pass

    original = matcher.new_activity_id
    matcher.new_activity_id = _DeterministicIds()
    try:
        result = StravaImporter(str(zip_path), str(out_path),
                                LocalArchive(str(work / "archive")), now=now).run()
    finally:
        matcher.new_activity_id = original
    if result["insert"] != len(rows):
        raise RuntimeError(f"importer inserted {result['insert']} of {len(rows)} demo activities")

    conn = db.connect(str(out_path))
    try:
        conn.execute("VACUUM")
        stats = {
            "inserted": result["insert"],
            "activities": conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0],
            "with_gps": conn.execute("SELECT COUNT(*) FROM activities WHERE has_gps=1").fetchone()[0],
            "with_hr": conn.execute("SELECT COUNT(*) FROM activities WHERE has_hr=1").fetchone()[0],
            "bytes": out_path.stat().st_size,
        }
    finally:
        conn.close()
    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--routes", default="data/demo/routes.json")
    ap.add_argument("--out", default="data/demo/activities.sqlite")
    args = ap.parse_args()
    with open(args.routes, encoding="utf-8") as f:
        routes_doc = json.load(f)
    with tempfile.TemporaryDirectory(prefix="activity-atlas-demo-") as work:
        stats = build(routes_doc, args.out, work)
    print(f"wrote {stats['activities']} activities ({stats['with_gps']} with GPS, "
          f"{stats['with_hr']} with heart rate) to {args.out}, {stats['bytes'] / 1e6:.1f} MB",
          file=sys.stderr)


if __name__ == "__main__":
    main()
