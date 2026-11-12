"""MCP tools over the activity database. The work happens in the sibling
modules; this file only exposes them, keeps the data fresh, and adds ``as_of``."""
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from . import activities, daily, geo, samples
from .database import Database, QueryError, run_query
from .filters import ActivityFilter
from .freshness import Syncer, as_of
from .guide import guide_text
from .places import PlaceFinder, PlaceLookupError

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)
OPEN_WORLD = ToolAnnotations(read_only_hint=False, open_world_hint=True)


@dataclass
class ServerContext:
    db: Database
    syncer: Syncer
    places: PlaceFinder
    # The SDK runs sync tools in worker threads, so parallel calls would share the
    # SQLite connections; a reopen closing them under a running query crashes the
    # process. Every tool call (sync, reopen, the work itself) holds this lock.
    lock: threading.RLock = field(default_factory=threading.RLock)


def _filter(types, date_from, date_to, name_contains, min_distance_m, max_distance_m, min_moving_s,
            has_hr, has_gps, include_hidden, place) -> ActivityFilter:
    return ActivityFilter(types=types, date_from=date_from, date_to=date_to, name_contains=name_contains,
                          min_distance_m=min_distance_m, max_distance_m=max_distance_m,
                          min_moving_s=min_moving_s, has_hr=has_hr, has_gps=has_gps,
                          include_hidden=include_hidden, place=place)


def build_server(ctx: ServerContext) -> MCPServer:
    server = MCPServer(name="activity-atlas", instructions=guide_text(ctx.db))

    def run(fn: Callable[[], dict], force_sync: bool = False) -> dict:
        with ctx.lock:
            # Reopen after our own sync, and also when `npm run sync` or a local
            # writer replaced the file behind our back.
            if ctx.syncer.maybe_sync(force=force_sync) or ctx.db.changed_on_disk():
                ctx.db.reopen()
            try:
                result = fn()
            except (ValueError, QueryError, PlaceLookupError) as exc:
                raise ToolError(str(exc)) from exc
            return {**result, "as_of": as_of(ctx.db, ctx.syncer)}

    @server.tool(annotations=READ_ONLY)
    def guide() -> dict:
        """The data guide: what the tables and columns mean, units, the definitions every tool applies
        (local dates, Monday weeks, pace = total moving time / total distance, HR weighted by moving time),
        which tool to use when, and the current coverage. Read it before a first analysis."""
        return run(lambda: {"data": {"guide": guide_text(ctx.db)}, "counted": activities.counted([], 1)})

    @server.tool(annotations=OPEN_WORLD)
    def sync() -> dict:
        """Check R2 for a newer database now and download it if there is one (read-only token). This also
        happens by itself at most once an hour; use it when the owner just finished an activity."""
        return run(lambda: {"data": {}, "counted": activities.counted([], 0)}, force_sync=True)

    @server.tool(annotations=READ_ONLY)
    def list_activities(types: list[str] | None = None, date_from: str | None = None,
                        date_to: str | None = None, name_contains: str | None = None,
                        min_distance_m: float | None = None, max_distance_m: float | None = None,
                        min_moving_s: float | None = None, has_hr: bool | None = None,
                        has_gps: bool | None = None, include_hidden: bool = False, place: str | None = None,
                        sort: str = "date_desc", limit: int = 200, offset: int = 0) -> dict:
        """List activities matching filters. Dates are inclusive local YYYY-MM-DD. types are exact
        activity types (e.g. ["Run"]); no grouping. place: a place id or name from the places tool (case
        and accents ignored). sort: date_desc, date_asc, distance_desc, moving_desc, gain_desc. Rows: id,
        date, type, name, distance_km, moving_min, pace_min_km, speed_kmh, gain_m, avg_hr; unknown values
        are null."""
        f = _filter(types, date_from, date_to, name_contains, min_distance_m, max_distance_m, min_moving_s,
                    has_hr, has_gps, include_hidden, place)
        return run(lambda: activities.list_activities(ctx.db, f, sort, limit, offset))

    @server.tool(annotations=READ_ONLY)
    def get_activity(activity_id: str) -> dict:
        """One activity in full: numbers, HR zones, laps, gear and its Strava/Garmin source links."""
        return run(lambda: activities.get_activity(ctx.db, activity_id))

    @server.tool(annotations=READ_ONLY)
    def summarize(types: list[str] | None = None, date_from: str | None = None, date_to: str | None = None,
                  name_contains: str | None = None, min_distance_m: float | None = None,
                  max_distance_m: float | None = None, min_moving_s: float | None = None,
                  has_hr: bool | None = None, has_gps: bool | None = None, include_hidden: bool = False,
                  place: str | None = None, period: str = "year", by_type: bool = True) -> dict:
        """Totals and averages per period (week, month, year, all) and per type: count, distance, moving
        and elapsed time, elevation gain, pace/speed (total moving time / total distance), avg HR (weighted
        by moving time), with how many activities each figure is based on. Use this for trends. place: a
        place id or name from the places tool (case and accents ignored)."""
        f = _filter(types, date_from, date_to, name_contains, min_distance_m, max_distance_m, min_moving_s,
                    has_hr, has_gps, include_hidden, place)
        return run(lambda: activities.summarize(ctx.db, f, period, by_type))

    @server.tool(annotations=READ_ONLY)
    def places() -> dict:
        """The places the owner has reached (summits and passes, found from the tracks), with id, name,
        how the name was chosen (owner, activity_names, osm, fallback), kind, elevation and how many
        activities reached each, most visited first. Pass an id or name to the place filter of
        list_activities or summarize."""
        return run(lambda: activities.places(ctx.db))

    @server.tool(annotations=READ_ONLY)
    def same_route(activity_id: str) -> dict:
        """Every activity on the same route as this one (same type, similar distance, the same line on the
        map), newest first and including this one, with the route's id and name. route is null when the
        activity shares its route with no other."""
        return run(lambda: activities.same_route(ctx.db, activity_id))

    @server.tool(annotations=READ_ONLY)
    def activity_samples(activity_id: str, channels: list[str] | None = None, every_s: float | None = None,
                         max_points: int = samples.DEFAULT_MAX_POINTS) -> dict:
        """One activity's samples along the route, averaged into time buckets (at most max_points rows).
        channels: lat, lon, altitude, hr, cadence, speed, distance, power, temperature (default: all
        recorded). t_s is seconds from the start."""
        return run(lambda: samples.activity_samples(ctx.db, activity_id, channels, every_s, max_points))

    @server.tool(annotations=READ_ONLY)
    def wellness(date_from: str, date_to: str, metrics: list[str] | None = None, period: str = "day",
                 max_rows: int = daily.DEFAULT_MAX_DAYS) -> dict:
        """Daily wellness numbers (resting_hr, hrv_avg, sleep_s, sleep_score, steps, stress_avg,
        body_battery_high/low, weight_kg, spo2_avg, respiration columns, ...) per day (at most 366 days per
        call), or per week/month/year/all as mean, min, max and days_with_value."""
        return run(lambda: daily.wellness(ctx.db, date_from, date_to, metrics, period, max_rows))

    @server.tool(annotations=READ_ONLY)
    def wellness_series(date: str, channel: str, every_s: float | None = None,
                        max_points: int = samples.DEFAULT_MAX_POINTS) -> dict:
        """One day's all-day series (channel hr, hrv, stress or respiration) in local clock time, averaged
        into buckets. An empty result reports the dates that channel covers."""
        return run(lambda: samples.wellness_series(ctx.db, date, channel, every_s, max_points))

    @server.tool(annotations=OPEN_WORLD)
    def find_place(query: str) -> dict:
        """Look up a place name in OpenStreetMap (only the name leaves the machine; cached). Returns up to
        5 candidates with kind, coordinates, elevation and country. Use before activities_near. For a
        summit or pass the owner has reached, the places tool and the place filter come first."""
        return run(lambda: ctx.places.find(query))

    @server.tool(annotations=READ_ONLY)
    def activities_near(lat: float, lon: float, radius_m: float = geo.DEFAULT_RADIUS_M, mode: str = "route",
                        types: list[str] | None = None, date_from: str | None = None,
                        date_to: str | None = None, include_hidden: bool = False, limit: int = 50) -> dict:
        """Activities that came within radius_m (default 200 m) of a point, nearest first, with the closest
        distance and when it happened. mode: route (anywhere on the track), start, or end."""
        f = ActivityFilter(types=types, date_from=date_from, date_to=date_to, include_hidden=include_hidden)
        return run(lambda: geo.activities_near(ctx.db, lat, lon, radius_m, mode, f, limit))

    @server.tool(annotations=READ_ONLY)
    def query(sql: str, params: list | None = None, max_rows: int = 200) -> dict:
        """Read-only SQL over the database (SQLite) for questions the other tools do not cover. Rows are
        capped; queries stop after 10 s. Raw payload columns read as NULL. See the guide for tables."""
        return run(lambda: run_query(ctx.db, sql, params, max_rows))

    return server
