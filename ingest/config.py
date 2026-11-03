"""Environment lookup shared by the ingest modules: process env first, then
the repo-root ``.env`` (the same file Vite reads for ``VITE_MAPBOX_TOKEN``).
Stdlib only.
"""
import os

DOTENV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def dotenv_value(path: str, name: str) -> str | None:
    """``name`` from a KEY=VALUE .env file; None when the file or value is absent/empty.

    Accepts an ``export `` prefix and strips one pair of matching quotes.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        if sep and key.strip() == name:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1].strip()
            return value or None
    return None


def env(name: str) -> str | None:
    """``os.environ[name]`` when non-empty, else the value from ``DOTENV_FILE``, else None."""
    value = os.environ.get(name)
    if value and value.strip():
        return value.strip()
    return dotenv_value(DOTENV_FILE, name)
