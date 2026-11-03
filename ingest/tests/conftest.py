"""Keep every test off the network and off the developer's real R2 settings."""
import os

import pytest

from ingest import config


@pytest.fixture(autouse=True)
def _isolate_r2_settings(request, monkeypatch, tmp_path_factory):
    # The opt-in live R2 test needs the real settings.
    if getattr(request.module, "USES_LIVE_R2", False):
        return
    for name in [n for n in os.environ if n.startswith("R2_")] + ["ARCHIVE_URL"]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(config, "DOTENV_FILE", str(tmp_path_factory.getbasetemp() / "no-such-dotenv"))
