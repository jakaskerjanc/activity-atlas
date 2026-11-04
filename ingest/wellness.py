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
  CHANNEL_SCALES, "stress" / "respiration" / "hrv" from SERIES_SCALES);
- ``utc_offset_s``: the offset of the first input in series precedence (see
  _series_rank; then by provider, key) that has samples for the channel.
Samples come from monitoring FITs (hr, stress, respiration) and from the
Personal API's heart_rate (hr) and hrv (hrv) responses. Within a source they
are the union over its inputs, sorted by (unix_s, value), keeping the first
sample per instant; a source ranked later only adds samples at least
SERIES_OVERLAP_S from every sample already kept (see _merge_series).
"""
import bisect
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
    observed_s: int | None = None     # when the stats were read; the latest wins within a source


# local date -> part. A parser may depend only on the bytes and the record's
# provider, source, key and file_name: an input stored by an earlier call is
# re-parsed from a stub record with an empty fetched_at and origin.
DayParser = Callable[[bytes, WellnessRecord], dict[str, DayPart]]

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
        p.observed_s = m.resting_at.get(day)
    return parts


register(MONITORING_FIT, _monitoring_parts)


def _stats_columns(conn) -> list[str]:
    return [r[1] for r in conn.execute("PRAGMA table_info(daily_stats)") if r[1] not in ("date", "raw")]


# A source's sample is dropped when a sample of a source ranked before it lies
# closer than this: the API's heart rate is a 2-minute series.
SERIES_OVERLAP_S = 120


def _series_rank(source: str) -> tuple[bool, str]:
    """Series precedence, the reverse of the stats': a monitoring FIT holds
    the watch's own samples (about one a minute), while the API's heart rate
    is a 2-minute summary of the same readings that differs from them at the
    instants both have. So the FIT's samples are kept whole and the API's only
    fill the stretches the FIT does not cover (the hours after an export, the
    days after it, the gaps in it)."""
    return (source != MONITORING_FIT, source)


def _merge_series(inputs: list[tuple[str, list[tuple[int, float, int]]]]) -> list[tuple]:
    """inputs: (source, [(unix_s, value, time_of_day)]) in precedence order.
    Within a source the samples are unioned, keeping the lowest value per
    instant; a later source adds only its samples at least SERIES_OVERLAP_S
    from every sample kept from the sources before it. So no instant is
    sampled twice, and a later source only fills gaps of the earlier ones
    (at least 2 * SERIES_OVERLAP_S wide inside their span)."""
    kept: list[tuple] = []
    by_source: dict[str, list[tuple]] = {}
    for source, samples in inputs:
        by_source.setdefault(source, []).extend(samples)
    for source, samples in by_source.items():
        earlier = [s[0] for s in kept]           # sorted
        samples.sort()
        for i, s in enumerate(samples):
            if i and s[0] == samples[i - 1][0]:
                continue
            j = bisect.bisect_left(earlier, s[0])
            if (j < len(earlier) and earlier[j] - s[0] < SERIES_OVERLAP_S) or \
                    (j and s[0] - earlier[j - 1] < SERIES_OVERLAP_S):
                continue
            kept.append(s)
        kept.sort()
    return kept


def _recompute_day(conn, day: str, parts: list[tuple[str, DayPart]], columns: list[str]) -> None:
    """parts: (source, part) ordered by (provider, source, key)."""
    conn.execute("DELETE FROM daily_stats WHERE date=?", (day,))
    conn.execute("DELETE FROM daily_series WHERE date=?", (day,))
    if not parts:
        return

    # API daily figures beat our reading of a FIT. Within a source the latest
    # reading comes first; the sort is stable, so inputs without a reading
    # time keep their (provider, key) order after those with one
    ranked = sorted(parts, key=lambda sp: (sp[0] == MONITORING_FIT, sp[0],
                                           0 if sp[1].observed_s is None else -sp[1].observed_s))
    stats = dict.fromkeys(columns)
    for source, p in ranked:
        unknown = set(p.stats) - set(columns)
        if unknown:
            raise ValueError(f"{source}: unknown daily_stats columns {sorted(unknown)}")
        for col, v in p.stats.items():
            if stats[col] is None:
                stats[col] = v
    # several inputs of one source merge like the stats: the input ranked
    # first wins per field and a None never overwrites a value
    raw: dict[str, object] = {}
    for source, p in ranked:
        if p.raw is None:
            continue
        if isinstance(raw.get(source), dict) and isinstance(p.raw, dict):
            merged = raw[source]
            for k, v in p.raw.items():
                if merged.get(k) is None:
                    merged[k] = v
        else:
            raw.setdefault(source, dict(p.raw) if isinstance(p.raw, dict) else p.raw)
    conn.execute(f"INSERT INTO daily_stats (date, {', '.join(columns)}, raw) "
                 f"VALUES ({', '.join('?' * (len(columns) + 2))})",
                 (day, *(stats[c] for c in columns),
                  json.dumps(raw, sort_keys=True, separators=(",", ":")) if raw else None))

    midnight = int(datetime.combine(Date.fromisoformat(day), datetime.min.time(), timezone.utc).timestamp())
    by_precedence = sorted(parts, key=lambda sp: _series_rank(sp[0]))     # stable: (provider, key) within a source
    channels = sorted({ch for _, p in parts for ch, samples in p.series.items() if samples})
    for ch in channels:
        offset = next(p.utc_offset_s for _, p in by_precedence if p.series.get(ch))
        kept = _merge_series([(source, [(t, v, t + (p.utc_offset_s or 0) - midnight)
                                         for t, v in p.series.get(ch, ())])
                               for source, p in by_precedence])
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
