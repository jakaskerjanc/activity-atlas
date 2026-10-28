"""Wellness inputs -> daily_stats and daily_series, recomputed per local date.

Each wellness record's blob is parsed into one DayPart per local date it
covers; wellness_inputs maps (provider, source, key) to those dates. A date is
always recomputed from all of its inputs, so the result does not depend on
the order the inputs arrived in.

daily_series holds one row per (date, channel):
- ``time``: seconds from the date's local midnight, encoded as codec channel
  "time" (each sample shifted by its own input's UTC offset; UTC midnight when
  the input has no offset);
- ``data``: the values, encoded as the row's channel ("hr" from
  CHANNEL_SCALES, "stress" / "respiration" from SERIES_SCALES);
- ``utc_offset_s``: the offset of the first input (by provider, source, key)
  that has samples for the channel.
Samples are the union over the inputs, sorted by (unix_s, value), keeping the
first sample per instant.
"""
import importlib
import json
import warnings
from dataclasses import dataclass
from datetime import date as Date, datetime, timezone
from typing import Callable, Iterable

from . import codec
from .archive import Archive
from .engine import _raw_file
from .parse.monitoring import parse_monitoring
from .records import WellnessRecord


@dataclass
class DayPart:
    stats: dict[str, float | str | None]               # daily_stats column -> value
    raw: object | None                                 # goes into daily_stats.raw[source]
    series: dict[str, list[tuple[int, float]]]         # channel -> [(unix_s, value)]
    utc_offset_s: int | None


DayParser = Callable[[bytes, WellnessRecord], dict[str, DayPart]]   # local date -> part

_PARSERS: dict[str, DayParser] = {}

# where each origin kind's parsers are registered, so a rebuild can find them
_PARSER_MODULES = {"garmin_api": "ingest.garmin_wellness"}

MONITORING_FIT = "monitoring_fit"


def register(source: str, parser: DayParser) -> None:
    _PARSERS[source] = parser


def _parser(rec: WellnessRecord) -> DayParser:
    """An input re-read from wellness_inputs has no origin, so every module
    is tried for it."""
    if rec.source not in _PARSERS:
        kind = rec.origin.get("kind")
        for k, module in sorted(_PARSER_MODULES.items()):
            if kind in (k, None):
                importlib.import_module(module)
    return _PARSERS[rec.source]


def _parse(rec: WellnessRecord, archive: Archive) -> dict[str, DayPart]:
    parser = _parser(rec)
    try:
        return parser(archive.get_blob(rec.blob_sha256), rec)
    except Exception as e:  # any corrupt or truncated input: it contributes nothing
        warnings.warn(f"unreadable wellness input {rec.source} {rec.key}: {e}")
        return {}


def _local_date(unix_s: int, offset: int | None) -> str:
    return datetime.fromtimestamp(unix_s + (offset or 0), timezone.utc).date().isoformat()


def _monitoring_parts(data: bytes, rec: WellnessRecord) -> dict[str, DayPart]:
    m = parse_monitoring(data)
    parts: dict[str, DayPart] = {}

    def part(day: str) -> DayPart:
        return parts.setdefault(day, DayPart({"resting_hr": None}, None, {}, m.utc_offset_s))

    for channel, samples in m.series.items():
        for t, v in samples:
            part(_local_date(t, m.utc_offset_s)).series.setdefault(channel, []).append((t, v))
    for day, resting in m.resting.items():
        p = part(day)
        p.stats = {"resting_hr": resting["current_day_resting_heart_rate"]}
        p.raw = resting
    return parts


register(MONITORING_FIT, _monitoring_parts)


def _stats_columns(conn) -> list[str]:
    return [r[1] for r in conn.execute("PRAGMA table_info(daily_stats)") if r[1] not in ("date", "raw")]


def _recompute_day(conn, day: str, parts: list[tuple[str, DayPart]], columns: list[str]) -> None:
    """parts: (source, part) ordered by (provider, source, key)."""
    conn.execute("DELETE FROM daily_stats WHERE date=?", (day,))
    conn.execute("DELETE FROM daily_series WHERE date=?", (day,))
    if not parts:
        return

    # API daily figures beat our reading of a FIT; the sort is stable, so
    # inputs of one source keep their (provider, key) order
    stats = dict.fromkeys(columns)
    for source, p in sorted(parts, key=lambda sp: (sp[0] == MONITORING_FIT, sp[0])):
        unknown = set(p.stats) - set(columns)
        if unknown:
            raise ValueError(f"{source}: unknown daily_stats columns {sorted(unknown)}")
        for col, v in p.stats.items():
            if stats[col] is None:
                stats[col] = v
    raw: dict[str, object] = {}
    for source, p in parts:
        if p.raw is None:
            continue
        if isinstance(raw.get(source), dict) and isinstance(p.raw, dict):
            raw[source] = {**raw[source], **p.raw}
        else:
            raw.setdefault(source, p.raw)
    conn.execute(f"INSERT INTO daily_stats (date, {', '.join(columns)}, raw) "
                 f"VALUES ({', '.join('?' * (len(columns) + 2))})",
                 (day, *(stats[c] for c in columns),
                  json.dumps(raw, sort_keys=True, separators=(",", ":")) if raw else None))

    midnight = int(datetime.combine(Date.fromisoformat(day), datetime.min.time(), timezone.utc).timestamp())
    channels = sorted({ch for _, p in parts for ch, samples in p.series.items() if samples})
    for ch in channels:
        offset = next(p.utc_offset_s for _, p in parts if p.series.get(ch))
        samples = sorted((t, v, t + (p.utc_offset_s or 0) - midnight)
                         for _, p in parts for t, v in p.series.get(ch, ()))
        kept = [s for i, s in enumerate(samples) if i == 0 or s[0] != samples[i - 1][0]]
        conn.execute("INSERT INTO daily_series (date, channel, sample_count, encoding, utc_offset_s, time, data) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (day, ch, len(kept), codec.ENCODING_VERSION, offset,
                      codec.encode("time", [s[2] for s in kept]), codec.encode(ch, [s[1] for s in kept])))


def apply_wellness(conn, archive: Archive, records: Iterable[WellnessRecord]) -> int:
    """Store each record's inputs, then recompute every date they touch (old
    dates and new) from all of that date's inputs. Returns the number of
    dates recomputed."""
    parsed: dict[tuple[str, str, str], dict[str, DayPart]] = {}
    affected: set[str] = set()
    for rec in records:
        kind = MONITORING_FIT if rec.source == MONITORING_FIT else "api_response"
        _raw_file(conn, archive, rec.blob_sha256, kind, rec.provider, rec.key, rec.file_name, rec.fetched_at)
        ident = (rec.provider, rec.source, rec.key)
        parts = parsed[ident] = _parse(rec, archive)
        affected |= {r[0] for r in conn.execute(
            "SELECT date FROM wellness_inputs WHERE provider=? AND source=? AND key=?", ident)}
        affected |= set(parts)
        conn.execute("DELETE FROM wellness_inputs WHERE provider=? AND source=? AND key=?", ident)
        conn.executemany("INSERT INTO wellness_inputs (provider, source, key, date, blob_sha256, file_name) "
                         "VALUES (?, ?, ?, ?, ?, ?)",
                         [(*ident, day, rec.blob_sha256, rec.file_name) for day in sorted(parts)])

    columns = _stats_columns(conn)
    for day in sorted(affected):
        day_parts = []
        for r in conn.execute("SELECT provider, source, key, blob_sha256, file_name FROM wellness_inputs "
                              "WHERE date=? ORDER BY provider, source, key", (day,)).fetchall():
            ident = (r[0], r[1], r[2])
            if ident not in parsed:     # an input stored by an earlier call
                parsed[ident] = _parse(WellnessRecord(*ident, "", r[3], r[4], {}), archive)
            if day in parsed[ident]:
                day_parts.append((r[1], parsed[ident][day]))
        _recompute_day(conn, day, day_parts, columns)
    return len(affected)
