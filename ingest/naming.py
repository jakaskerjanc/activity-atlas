"""Names for places and routes. The module layering keeps ``naming`` free of ``osm``."""
from dataclasses import dataclass


@dataclass(frozen=True)
class OsmPoint:
    osm_id: str
    kind: str
    name: str
    lat: float
    lon: float
    ele: float | None
