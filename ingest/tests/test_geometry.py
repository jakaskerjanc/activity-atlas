import math
import random

from ingest.geometry import (discrete_frechet, farthest_index, frechet_below, haversine_m, project, resample,
                             route_shape, smooth, track_top)
from ingest.tests.track_fixture import climb_alts, line, loop, offset, out_and_back

A = (45.6, 14.0)


def test_haversine_one_degree_lat():
    assert abs(haversine_m(46, 14, 47, 14) - 111_195) < 50


def test_project_far_north_keeps_metres():
    a = (68.2, 13.6)
    b = offset([a], east_m=100, north_m=0)[0]
    (x0, y0), (x1, y1) = project([a, b], a)
    assert abs(math.hypot(x1 - x0, y1 - y0) - 100) < 1


def test_resample_even_spacing():
    xy = project(line(A, 30, 3000, 200), A)
    r = resample(xy, 64)
    assert len(r) == 64
    gaps = [math.dist(p, q) for p, q in zip(r, r[1:])]
    assert max(gaps) - min(gaps) < 1


def test_resample_zero_length():
    assert resample([(1.0, 2.0), (1.0, 2.0)], 5) == [(1.0, 2.0)] * 5


def test_frechet_identical_zero_and_offset():
    pts = line(A, 90, 3000, 50)
    xy = project(pts, A)
    assert discrete_frechet(xy, xy) == 0
    shifted = project(offset(pts, 100, 0), A)
    assert abs(discrete_frechet(xy, shifted) - 100) < 2


def test_frechet_reversed_is_large():
    xy = resample(project(line(A, 0, 5000, 100), A), 64)
    assert discrete_frechet(xy, xy[::-1]) > 1000


def _limits(d: float) -> list[float]:
    """Limits around a Fréchet distance d: at it, one float either side of it, and further off."""
    return [0.0, d, math.nextafter(d, math.inf), math.nextafter(d, 0), d * 0.9, d * 1.1, d + 50, max(d - 50, 0)]


def _agrees(p, q) -> None:
    d = discrete_frechet(p, q)
    for limit in _limits(d):
        assert frechet_below(p, q, limit) == (d < limit), (p, q, limit)


def test_frechet_below_agrees_with_discrete_frechet_on_random_walks():
    rng = random.Random(5)

    def walk(n: int, step: float) -> list[tuple[float, float]]:
        x = y = 0.0
        pts = []
        for _ in range(n):
            x, y = x + rng.uniform(-step, step), y + rng.uniform(-step, step)
            pts.append((x, y))
        return pts

    for _ in range(400):
        p = walk(rng.randint(1, 30), rng.choice((10, 100)))
        kind = rng.randrange(3)
        if kind == 0:     # unrelated
            q = walk(rng.randint(1, 30), rng.choice((10, 100)))
        elif kind == 1:   # p with noise, sometimes thinned or reversed
            q = [(x + rng.uniform(-30, 30), y + rng.uniform(-30, 30)) for x, y in p if rng.random() < 0.8] or p[:1]
            q = q[::-1] if rng.random() < 0.3 else q
        else:             # p with a detour in the middle
            q = list(p)
            i = len(q) // 2
            q[i] = (q[i][0] + rng.uniform(100, 400), q[i][1])
        _agrees(p, q)
        _agrees(q, p)


def test_frechet_below_agrees_on_resampled_tracks():
    base = resample(project(line(A, 30, 3000, 200), A), 64)
    for east in (0, 100, 249, 250, 251, 400):
        shifted = resample(project(offset(line(A, 30, 3000, 200), east, 0), A), 64)
        for q in (shifted, shifted[::-1]):
            _agrees(base, q)
    circle = resample(project(loop(A, 500, 300), A), 64)
    for start in (0, 10, 45, 90, 180):
        other = resample(project(loop(A, 520, 300, start_deg=start), A), 64)
        for q in (other, other[::-1]):
            _agrees(circle, q)
    out_back = resample(project(out_and_back(A, 0, 2000, 300), A), 64)
    _agrees(out_back, resample(project(line(A, 0, 2000, 200), A), 64))
    _agrees(out_back, out_back[::-1])


def test_frechet_below_single_points_and_ends():
    assert frechet_below([(0.0, 0.0)], [(3.0, 4.0)], 5.0000001)
    assert not frechet_below([(0.0, 0.0)], [(3.0, 4.0)], 5.0)
    # Close everywhere but at the last pair: the end check alone rules it out.
    p = [(float(i), 0.0) for i in range(10)]
    assert not frechet_below(p, p[:-1] + [(9.0, 300.0)], 250)
    assert frechet_below(p, p[:-1] + [(9.0, 249.0)], 250)


def test_smooth_edges():
    assert smooth([0, 0, 9, 0, 0], window=3) == [0, 3, 3, 3, 0]


def test_top_needs_50_m_climb():
    n = 1000
    pts = line(A, 0, 3000, n)
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    assert track_top(lats, lons, climb_alts(n, 49)) is None
    top = track_top(lats, lons, climb_alts(n, 120))
    assert top is not None and abs(top.climb - 120) < 5
    assert abs(top.ele - 420) < 5


def test_top_ignores_single_spike():
    n = 100
    pts = line(A, 0, 3000, n)
    alts = [300.0] * n
    alts[60] += 300
    assert track_top([p[0] for p in pts], [p[1] for p in pts], alts) is None


def test_top_skips_none_holes():
    n = 100
    pts = line(A, 0, 3000, n)
    alts = climb_alts(n, 120)
    for i in range(0, n, 7):
        alts[i] = None
    assert track_top([p[0] for p in pts], [p[1] for p in pts], alts) is not None


def test_top_none_without_altitude():
    assert track_top([46.0] * 40, [14.0] * 40, [None] * 40) is None


def test_top_needs_30_samples():
    n = 29
    pts = line(A, 0, 3000, n)
    assert track_top([p[0] for p in pts], [p[1] for p in pts], climb_alts(n, 200)) is None


def test_shapes():
    assert route_shape(project(loop(A, 800, 100), A)) == "loop"
    assert route_shape(project(out_and_back(A, 0, 5000, 100), A)) == "out-and-back"
    assert route_shape(project(line(A, 0, 5000, 100), A)) == "point-to-point"


def test_farthest_index_skips_ends():
    xy = [(0.0, 0.0), (0.0, 2000.0), (0.0, 4000.0), (0.0, 5900.0), (0.0, 6000.0)]
    assert farthest_index(xy) == 4
    assert farthest_index(xy, skip_m=500) == 2
    # a spike within 400 m of the start is ignored with skip_m=500
    spike = [(0.0, 0.0), (0.0, 400.0), (0.0, 100.0), (0.0, 3000.0), (0.0, 100.0), (0.0, 0.0)]
    assert farthest_index(spike, skip_m=500) == 3
    # every point ignored: plain farthest
    assert farthest_index([(0.0, 0.0), (0.0, 300.0), (0.0, 0.0)], skip_m=500) == 1


def test_insert_activity_fixture(tmp_path):
    from ingest import db
    from ingest.tests.track_fixture import insert_activity
    conn = db.open_db(str(tmp_path / "t.db"))
    pts = line(A, 0, 3000, 40)
    insert_activity(conn, "a", "Hike", "2025-05-01T07:00:00+00:00", pts, alts=climb_alts(40, 100))
    insert_activity(conn, "b", "Hike", "2025-05-02T07:00:00+00:00", pts)
    rows = {r[0]: r[1:] for r in conn.execute(
        "SELECT a.id, a.distance, a.has_gps, s.altitude IS NOT NULL FROM activities a "
        "JOIN streams s ON s.file_sha256 = a.streams_sha256")}
    assert abs(rows["a"][0] - 3000) < 5 and rows["a"][1] == 1
    assert rows["a"][2] == 1 and rows["b"][2] == 0


def test_shape_resampled_out_and_back_with_wobbly_return():
    # 10 km out-and-back whose return wobbles +-25 m sideways: always within 50 m of the
    # outbound line, but after resampling to 64 points (~160 m apart) the return samples
    # fall between the outbound ones.
    out = line(A, 0, 5000, 200)
    back = [offset([p], 25 * math.sin(i / 3), 0)[0] for i, p in enumerate(line(out[-1], 180, 5000, 200))]
    xy = resample(project(out + back[1:], A), 64)
    assert route_shape(xy) == "out-and-back"
    assert route_shape(resample(project(loop(A, 800, 100), A), 64)) == "loop"
