import gzip
import io

from . import ParsedFile


def parse_bytes(name: str, data: bytes) -> ParsedFile:
    """Parse an activity file by name: .fit / .tcx / .gpx, optionally .gz."""
    from .fit import parse_fit
    from .tcx import parse_tcx
    from .gpx import parse_gpx
    low = name.lower()
    if low.endswith(".gz"):
        data, low = gzip.decompress(data), low[:-3]
    for ext, parser in ((".fit", parse_fit), (".tcx", parse_tcx), (".gpx", parse_gpx)):
        if low.endswith(ext):
            return parser(io.BytesIO(data))
    raise ValueError(f"unsupported activity file: {name}")
