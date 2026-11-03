"""Write ``scripts/fixtures/codec.json``: blobs encoded by ``ingest.codec`` for
the Node decoder's test (``scripts/codec.test.ts``).

Regenerate after any codec change::

    .venv/bin/python -m ingest.tests.codec_fixture

``test_codec_fixture.py`` fails when the committed file drifts from the encoder.
"""
import base64
import json
import os

from ingest import codec

FIXTURE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "scripts", "fixtures", "codec.json",
)

CASES: list[tuple[str, str, list[float | None]]] = [
    ("time 1 Hz", "time", [0, 1, 2, 3, 5, 8]),
    ("time empty", "time", []),
    ("lat", "lat", [46.0512345, 46.0512399, 46.0511]),
    ("lon antimeridian", "lon", [179.9999999, -179.9999999]),
    ("altitude up and down", "altitude", [312.4, 310.1, None, 315.0]),
    ("hr missing start middle end", "hr", [None, 98, 101, None, 104, None]),
    ("cadence", "cadence", [80, 82, 0, 81]),
    ("speed", "speed", [1.234, 0.0, 3.5, None, 2.999]),
    ("distance", "distance", [0.0, 3.21, 7.5, 12.04]),
    ("power", "power", [210, 250, None, 0]),
    ("temperature negative", "temperature", [-3, -2, 1]),
    ("hr all missing", "hr", [None, None]),
]


def build() -> dict:
    cases = []
    for name, channel, values in CASES:
        blob = codec.encode(channel, values)
        cases.append({
            "name": name,
            "channel": channel,
            "values": codec.decode(channel, blob),
            "blob": base64.b64encode(blob).decode("ascii"),
        })
    return {"encoding": codec.ENCODING_VERSION, "cases": cases}


def main() -> None:
    os.makedirs(os.path.dirname(FIXTURE_PATH), exist_ok=True)
    with open(FIXTURE_PATH, "w") as f:
        json.dump(build(), f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {FIXTURE_PATH}")


if __name__ == "__main__":
    main()
