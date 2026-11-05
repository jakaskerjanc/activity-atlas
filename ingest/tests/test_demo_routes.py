from ingest.demo.routes import densify, elevations, haversine_m


def test_densify_caps_the_gap_and_keeps_the_ends():
    points = [(46.5576, 15.6455), (46.5600, 15.7000)]
    out = densify(points, step_m=100)
    assert out[0] == points[0] and out[-1] == points[1]
    assert all(haversine_m(a, b) <= 100.01 for a, b in zip(out, out[1:]))
    assert len(out) > 2


def test_elevations_interpolate_between_fetched_samples():
    points = [(46.0, 15.0), (46.0, 15.0012), (46.0, 15.0024)]
    calls = []

    def fetch(picked):
        calls.append(picked)
        return [100.0, 300.0]

    out = elevations(points, fetch=fetch)
    assert [len(c) for c in calls] == [2]          # about every 150 m: first and last
    assert out[0] == 100.0 and out[-1] == 300.0
    assert 100.0 < out[1] < 300.0
