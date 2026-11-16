// The selected activity's charts, stacked on one x axis (distance, else time):
// elevation, heart rate, then pace (foot types) or speed. Each chart is its own SVG
// with its own y axis — never two scales on one plot. Pointer over any chart sets the
// shared cursor (a sample index): each chart's title line reads its value there, the
// caption above says where, and the map draws a marker at the same sample (MapView).
// At rest a title line can carry a whole-activity value instead (the high point). With
// zone limits, the heart-rate line is drawn in its zones' colors.
// Where there is room (minColumn), the charts sit side by side, each with its own
// x axis, in rows they fill; otherwise they stack on one. Model: ../profile.ts.

import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { FS, MONO } from "./theme";
import { Reading } from "./StatsSection";
import { useElementWidth } from "./useElementWidth";
import {
  areaPath,
  bandedLinePaths,
  linePath,
  nearestIndex,
  niceTicks,
  paceTicks,
  type ChartKind,
  type ChartSeries,
  type Profile,
} from "../profile";
import { formatClock, formatKm, formatMeters, formatPace } from "../format";
import { useMediaQuery } from "./useMediaQuery";
import type { DetailState } from "../detail";
import { ZONE_BANDS, zoneBand, zoneLabel } from "../hrZones";
import type { DetailFile } from "../types";

interface Props {
  detail: DetailFile;
  profile: Profile;
  cursor: number | null;
  onCursor: (i: number | null) => void;
  /** Only these charts; default all the profile has. */
  kinds?: readonly ChartKind[];
  /** Whether hovering the route on a map also moves the cursor, for the hint. Default true. */
  routeLinked?: boolean;
  /** A chart's title line at rest: a whole-activity value (the high point). */
  rests?: Partial<Record<ChartKind, ReactNode>>;
  /**
   * The narrowest a chart may be to sit beside another; without it (the map panel's
   * narrow column) the charts always stack.
   */
  minColumn?: number;
  /**
   * The heart-rate zones' lower bounds: the heart-rate line takes each zone's color
   * (the Analytics zones' violet ramp) and its readout names the zone.
   */
  zoneLimits?: readonly number[];
}

/** Stacked plot heights: elevation leads, the rest are strips under it. */
const HEIGHT: Record<ChartKind, number> = { elevation: 88, hr: 56, pace: 56, speed: 56, cadence: 48 };
/** Side by side, every plot is one height, so their axes line up. */
const ROW_HEIGHT = 64;
/** Between charts side by side. */
const COLUMN_GAP = 24;
const TITLE: Record<ChartKind, string> = {
  elevation: "Elevation",
  hr: "Heart rate",
  pace: "Pace",
  speed: "Speed",
  cadence: "Cadence",
};
const UNIT: Record<ChartKind, string> = { elevation: "m", hr: "bpm", pace: "/km", speed: "km/h", cadence: "per min" };
// Validated with the dataviz palette checker against both panel surfaces: accent,
// violet and cyan stay apart under colour-vision deficiency. Each chart is labelled,
// so identity never rests on colour alone.
const COLOR: Record<ChartKind, string> = {
  elevation: "var(--accent)",
  hr: "#b07cff",
  pace: "#3fb8e0",
  speed: "#3fb8e0",
  cadence: "#9ccc65",
};

/** Left gutter for y tick labels, right gutter so the last point isn't clipped. */
const PAD_L = 34;
const PAD_R = 4;
const PAD_Y = 4;
const FALLBACK_WIDTH = 400;

/** The muted line shown in place of charts, or null when charts render. */
export function detailMessage(state: DetailState, hasProfile: boolean): string | null {
  if (state.status === "loading") return "Loading samples…";
  if (state.status === "error") return "Couldn't load samples.";
  if (state.status === "ready" && hasProfile) return null;
  return "No samples recorded for this activity.";
}

function tickLabel(kind: ChartKind, v: number): string {
  return kind === "pace" ? formatPace(v) : String(Math.round(v));
}

/** A chart's value at one sample, as its title line reads it. */
function pointValue(kind: ChartKind, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (kind === "pace") return formatPace(v);
  if (kind === "speed") return v.toFixed(1);
  return kind === "elevation" ? formatMeters(v) : String(Math.round(v));
}

export function ActivityCharts({
  detail,
  profile,
  cursor,
  onCursor,
  kinds,
  routeLinked = true,
  rests = {},
  minColumn,
  zoneLimits,
}: Props) {
  const limits = zoneLimits && zoneLimits.length >= ZONE_BANDS - 1 ? zoneLimits : null;
  const [ref, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const canHover = useMediaQuery("(hover: hover)");
  const charts = profile.charts.filter((c) => !kinds || kinds.includes(c.kind));
  // Side by side in as many columns as fit at minColumn or wider, counting only column
  // counts that fill every row (four charts: four, two by two, or one), so no chart
  // ever sits alone beside a gap.
  const n = charts.length;
  const columnWidth = (c: number) => Math.floor((width - COLUMN_GAP * (c - 1)) / c);
  const columns = minColumn
    ? (Array.from({ length: n }, (_, i) => n - i).find((c) => n % c === 0 && columnWidth(c) >= minColumn) ?? 1)
    : 1;
  const side = columns > 1;
  const chartW = side ? columnWidth(columns) : width;

  const { x } = profile;
  const x0 = x[0];
  const x1 = x[x.length - 1] > x0 ? x[x.length - 1] : x0 + 1;
  const plotW = Math.max(1, chartW - PAD_L - PAD_R);
  const sx = (v: number) => PAD_L + ((v - x0) / (x1 - x0)) * plotW;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onCursor(nearestIndex(x, x0 + ((e.clientX - rect.left - PAD_L) / plotW) * (x1 - x0)));
  };
  const xCount = Math.max(3, Math.floor(plotW / 70));
  const xTicks =
    profile.xKind === "distance"
      ? niceTicks(x0 / 1000, x1 / 1000, xCount).map((km) => ({ at: km * 1000, label: `${km}` }))
      : niceTicks(x0, x1, xCount).map((s) => ({ at: s, label: formatClock(s) }));
  const axis = (
    <div style={{ position: "relative", height: 14, ...axisText }}>
      {xTicks.map((t) => (
        <span key={t.at} style={{ position: "absolute", left: sx(t.at), transform: "translateX(-50%)" }}>
          {t.label}
        </span>
      ))}
      <span style={{ position: "absolute", left: 0 }}>{profile.xKind === "distance" ? "km" : "time"}</span>
    </div>
  );

  // Where the cursor is (the distance and the time there); each chart reads its own value.
  const where =
    cursor == null
      ? null
      : profile.xKind === "distance"
        ? `At ${formatKm(x[cursor], 2)} km · ${formatClock(detail.t[cursor])}`
        : `At ${formatClock(x[cursor])}`;
  const hint = canHover ? (routeLinked ? "Hover the charts or the route" : "Hover the charts") : "Touch a chart to read a point";
  return (
    <div ref={ref}>
      <div style={captionRow} aria-live="polite">
        <span style={{ fontWeight: 600, color: where ? "var(--accent-text)" : "var(--text-soft)" }}>
          {where ?? (profile.xKind === "distance" ? "Along the route" : "Over time")}
        </span>
        {!where && <span style={{ color: "var(--text-faint)" }}>{hint}</span>}
      </div>

      {/* A grid, not a wrapping row: the columns come from CSS, so a width measured a
          frame late (the filters panel sliding) never wraps a chart onto its own row. */}
      <div
        style={
          side
            ? { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: `12px ${COLUMN_GAP}px` }
            : undefined
        }
      >
        {charts.map((c) => (
          <div key={c.kind} style={{ minWidth: 0, overflow: "hidden", marginTop: side ? 0 : 12 }}>
            <Chart
              aside={cursor == null ? rests[c.kind] : <PointReading kind={c.kind} v={c.values[cursor]} limits={limits} />}
              limits={c.kind === "hr" ? limits : null}
              height={side ? ROW_HEIGHT : HEIGHT[c.kind]}
              series={c}
              x={x}
              width={chartW}
              sx={sx}
              cursor={cursor}
              onMove={onMove}
              onLeave={() => onCursor(null)}
            />
            {side && axis}
          </div>
        ))}
      </div>
      {!side && axis}
    </div>
  );
}

/** A chart's value at the cursor; a heart rate also names its zone. */
function PointReading({ kind, v, limits }: { kind: ChartKind; v: number | null | undefined; limits: readonly number[] | null }) {
  const reading = <Reading value={pointValue(kind, v)} unit={UNIT[kind]} />;
  if (kind !== "hr" || !limits || v == null) return reading;
  return (
    <span>
      {reading}
      <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
        {"\u00a0·\u00a0"}
        {zoneLabel(zoneBand(v, limits))}
      </span>
    </span>
  );
}

interface ChartProps {
  series: ChartSeries;
  x: number[];
  width: number;
  height: number;
  sx: (v: number) => number;
  cursor: number | null;
  onMove: (e: PointerEvent<SVGSVGElement>) => void;
  onLeave: () => void;
  /** Right of the title: the value at the cursor, or the rest value. */
  aside?: ReactNode;
  /** Zone limits: the line in zone colors. */
  limits?: readonly number[] | null;
}

function Chart({ series, x, width, height: h, sx, cursor, onMove, onLeave, aside, limits }: ChartProps) {
  const { kind, values, domain, invert } = series;
  const top = PAD_Y;
  const bottom = h - PAD_Y;
  const [lo, hi] = domain;
  // Values outside the domain (pace beyond p5..p95) are clipped to its edge.
  const sy = (v: number) => {
    const f = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1);
    return invert ? top + f * (bottom - top) : bottom - f * (bottom - top);
  };
  const color = COLOR[kind];
  const ticks = kind === "pace" ? paceTicks(lo, hi) : niceTicks(lo, hi, 3);
  const cx = cursor == null ? null : sx(x[cursor]);
  const cv = cursor == null ? null : values[cursor];

  return (
    <div>
      <div style={{ ...chartTitle, display: "flex", justifyContent: "space-between", gap: 12, height: 16, whiteSpace: "nowrap" }}>
        <span>
          {TITLE[kind]} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{UNIT[kind]}</span>
        </span>
        {aside}
      </div>
      <svg
        width={width}
        height={h}
        style={{ display: "block", touchAction: "pan-y", cursor: "crosshair" }}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={onLeave}
        role="img"
        aria-label={`${TITLE[kind]}, ${UNIT[kind]}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={width - PAD_R} y1={sy(t)} y2={sy(t)} stroke="var(--card-grid)" strokeWidth={1} />
            <text x={PAD_L - 4} y={sy(t) + 3} textAnchor="end" style={axisText} fill="var(--text-muted)">
              {tickLabel(kind, t)}
            </text>
          </g>
        ))}
        {kind === "elevation" && (
          <path d={areaPath(x, values, sx, sy, bottom)} fill={color} fillOpacity={0.12} stroke="none" />
        )}
        {limits ? (
          bandedLinePaths(x, values, sx, sy, (v) => zoneBand(v, limits), ZONE_BANDS).map((d, band) =>
            d ? (
              <path key={band} d={d} fill="none" stroke={`var(--zone-line-${band})`} strokeWidth={1.75} strokeLinecap="round" />
            ) : null,
          )
        ) : (
          <path
            d={linePath(x, values, sx, sy)}
            fill="none"
            stroke={color}
            strokeWidth={kind === "elevation" ? 2 : 1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {cx != null && (
          <g data-cursor="">
            <line x1={cx} x2={cx} y1={0} y2={h} stroke="var(--text-soft)" strokeWidth={1} />
            {cv != null && (
              <circle
                cx={cx}
                cy={sy(cv)}
                r={4}
                fill={limits ? `var(--zone-line-${zoneBand(cv, limits)})` : color}
                stroke="var(--card-bg)"
                strokeWidth={2}
              />
            )}
          </g>
        )}
      </svg>
    </div>
  );
}

const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS["2xs"] - 0.5,
  color: "var(--text-muted)",
};

/** A chart's title ("Elevation m"), and the title of other small figures beside charts. */
export const chartTitle: CSSProperties = {
  fontSize: FS.xs + 0.5,
  fontWeight: 600,
  color: "var(--text-soft)",
  marginBottom: 3,
};

const captionRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 6,
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
};

