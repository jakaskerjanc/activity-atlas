import struct, zlib
import pytest
from ingest import codec

def test_round_trip_with_missing_and_negative_deltas():
    vals = [299.0, 298.4, None, 301.2, 120.0]
    assert codec.decode("altitude", codec.encode("altitude", vals)) == vals

def test_quantizes_to_channel_resolution():
    assert codec.decode("lat", codec.encode("lat", [46.051234567])) == [46.0512346]
    assert codec.decode("hr", codec.encode("hr", [112.4])) == [112.0]

def test_antimeridian_jump_does_not_overflow():
    vals = [-179.9, 179.9, -179.9]
    assert codec.decode("lon", codec.encode("lon", vals)) == vals

def test_empty_and_all_missing():
    assert codec.decode("hr", codec.encode("hr", [])) == []
    assert codec.decode("hr", codec.encode("hr", [None, None])) == [None, None]

def test_wire_format_is_zlib_int64_deltas_against_last_present_value():
    raw = zlib.decompress(codec.encode("time", [0, 1, None, 3]))
    assert struct.unpack("<4q", raw) == (0, 1, codec.MISSING, 2)

def test_unknown_channel_rejected():
    with pytest.raises(KeyError):
        codec.encode("vo2", [1.0])
