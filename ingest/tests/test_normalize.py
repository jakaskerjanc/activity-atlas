import warnings
import polyline
from ingest.normalize import canonical_type, simplify, encode


def test_canonical_type_strava_display_names():
    assert canonical_type("Run") == "Run"
    assert canonical_type("Weight Training") == "WeightTraining"
    assert canonical_type("Rock Climbing") == "RockClimbing"


def test_canonical_type_garmin_keys():
    assert canonical_type("running") == "Run"
    assert canonical_type("trail_running") == "Run"
    assert canonical_type("cycling") == "Ride"
    assert canonical_type("strength_training") == "WeightTraining"
    assert canonical_type("lap_swimming") == "Swim"
    assert canonical_type("tennis_v2") == "Tennis"


def test_canonical_type_types_seen_in_the_owners_data():
    # Strava's older "Rock Climb", Strava's "Water Sport" and Garmin's "paddelball" (padel)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert canonical_type("Rock Climb") == "RockClimbing"
        assert canonical_type("Water Sport") == "WaterSport"
        assert canonical_type("paddelball") == "Padel"
        assert canonical_type("padel") == "Padel"


def test_canonical_type_unmapped_warns_and_titlecases():
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        assert canonical_type("underwater_hockey") == "UnderwaterHockey"
        assert any("Unmapped" in str(x.message) for x in w)


def test_simplify_thins_dense_but_keeps_ends():
    # a near-straight dense line collapses to its two endpoints at 0.5 m
    line = [(46.0 + i * 1e-6, 14.0) for i in range(50)]
    out = simplify(line, 0.5)
    assert out[0] == line[0] and out[-1] == line[-1]
    assert len(out) < len(line)


def test_simplify_idempotent_on_sparse():
    sparse = [(46.0, 14.0), (46.01, 14.01), (46.02, 14.0)]
    assert simplify(simplify(sparse, 0.5), 0.5) == simplify(sparse, 0.5)


def test_encode_roundtrips_within_precision5():
    pts = [(46.06, 14.5), (46.07, 14.51)]
    dec = polyline.decode(encode(pts), 5)
    assert len(dec) == 2
    assert abs(dec[0][0] - 46.06) < 1e-4


def test_encode_empty_for_degenerate():
    assert encode([]) == ""
    assert encode([(46.0, 14.0)]) == ""

