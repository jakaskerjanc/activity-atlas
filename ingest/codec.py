"""Lossless stream codec, shared by the database (`streams`, `daily_series`)
and the Node display build.

Wire format (ENCODING_VERSION 1), one blob per channel:

1. Quantize each present value: ``q = round(v * CHANNEL_SCALES[channel])``.
2. Delta-encode: element ``i`` is ``q_i - prev``, where ``prev`` is the last
   *present* ``q`` before it (0 before the first). An absent sample is the
   sentinel ``MISSING`` (-2**63) and does not move ``prev``.
3. Pack as little-endian signed int64 (``struct`` format ``<{n}q``).
4. ``zlib.compress(..., 9)``.

Decoding reverses the steps and returns ``q / scale`` (``None`` for MISSING).
Deltas are int64 so a jump across the antimeridian (lon ±180 × 1e7) cannot
overflow; the quantized values themselves fit in int32.

``SERIES_SCALES`` adds the all-day wellness channels of ``daily_series``
(stress, respiration in breaths/min at 0.01). They are kept apart from
``CHANNEL_SCALES`` because that dict also defines the ``streams`` table's
columns; "hr" and "time" are shared and come from ``CHANNEL_SCALES``.
"""
import struct
import zlib

ENCODING_VERSION = 1

CHANNEL_SCALES: dict[str, float] = {
    "time": 1, "lat": 1e7, "lon": 1e7, "altitude": 10, "hr": 1, "cadence": 1,
    "speed": 1000, "distance": 100, "power": 1, "temperature": 1,
}

SERIES_SCALES: dict[str, float] = {"stress": 1, "respiration": 100}

MISSING: int = -(2 ** 63)


def _scale(channel: str) -> float:
    if channel in CHANNEL_SCALES:
        return CHANNEL_SCALES[channel]
    return SERIES_SCALES[channel]


def encode(channel: str, values: list[float | None]) -> bytes:
    scale = _scale(channel)
    out, prev = [], 0
    for v in values:
        if v is None:
            out.append(MISSING)
            continue
        q = round(v * scale)
        out.append(q - prev)
        prev = q
    return zlib.compress(struct.pack(f"<{len(out)}q", *out), 9)


def decode(channel: str, blob: bytes) -> list[float | None]:
    scale = _scale(channel)
    raw = zlib.decompress(blob)
    out, prev = [], 0
    for d in struct.unpack(f"<{len(raw) // 8}q", raw):
        if d == MISSING:
            out.append(None)
            continue
        prev += d
        out.append(prev / scale)
    return out
