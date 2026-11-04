"""The committed Node fixture must match what the Python encoder writes today."""
import json

from ingest.tests import codec_fixture


def test_committed_fixture_matches_encoder():
    with open(codec_fixture.FIXTURE_PATH) as f:
        committed = json.load(f)
    assert committed == codec_fixture.build(), (
        "scripts/fixtures/codec.json is stale; regenerate it with "
        "`.venv/bin/python -m ingest.tests.codec_fixture`"
    )
