// The selected activity's charts, stacked on one x axis (distance, else time):
// elevation, heart rate, then pace (foot types) or speed. Each chart is its own SVG
// with its own y axis — never two scales on one plot. Pointer over any chart sets the
// shared cursor (a sample index); the readout above shows the values there and the
// map draws a marker at the same sample (MapView). Model: ../profile.ts.

import type { CSSProperties, PointerEvent } from "react";
import { FS, MONO, R } from "./theme";
import { useElementWidth } from "./useElementWidth";
import {
  areaPath,
  linePath,
  nearestIndex,
  niceTicks,
  paceTicks,
  readout,
  summaryReadout,
  type ChartKind,
  type ChartSeries,
  type Profile,
} from "../profile";
import { formatClock, formatKm, formatPace } from "../format";
import { useMediaQuery } from "./useMediaQuery";
import type { DetailState } from "../detail";
import type { DetailFile } from "../types";

interface Props {
  detail: DetailFile;
  profile: Profile;
  type: string;
  cursor: number | null;
  onCursor: (i: number | null) => void;
}

const HEIGHT: Record<ChartKind, number> = { elevation: 104, hr: 72, pace: 72, speed: 72, cadence: 64 };
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

export function ActivityCharts({ detail, profile, type, cursor, onCursor }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const canHover = useMediaQuery("(hover: hover)");
  const { x } = profile;
  const x0 = x[0];
  const x1 = x[x.length - 1] > x0 ? x[x.length - 1] : x0 + 1;
  const plotW = Math.max(1, width - PAD_L - PAD_R);
  const sx = (v: number) => PAD_L + ((v - x0) / (x1 - x0)) * plotW;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const v = x0 + ((e.clientX - rect.left - PAD_L) / plotW) * (x1 - x0);
    onCursor(nearestIndex(x, v));
  };

  // At rest the chips show the whole activity; under the cursor, that point. Same chips,
  // same order, so reading values never reflows the panel.
  const items = cursor == null ? summaryReadout(detail, profile, type) : readout(detail, profile, cursor, type);
  const where =
    cursor == null
      ? "Whole activity"
      : profile.xKind === "distance"
        ? `At ${formatKm(x[cursor], 2)} km`
        : `At ${formatClock(x[cursor])}`;
  const xCount = Math.max(3, Math.floor(plotW / 70));
  const xTicks =
    profile.xKind === "distance"
      ? niceTicks(x0 / 1000, x1 / 1000, xCount).map((km) => ({ at: km * 1000, label: `${km}` }))
      : niceTicks(x0, x1, xCount).map((s) => ({ at: s, label: formatClock(s) }));

  return (
    <div ref={ref} style={{ marginTop: 14 }}>
      <div style={captionRow}>
        <span style={{ fontWeight: 600, color: cursor == null ? "var(--text-soft)" : "var(--accent-text)" }}>{where}</span>
        <span>{canHover ? "Hover the charts or the route" : "Touch a chart to read a point"}</span>
      </div>
      <div style={readoutRow} aria-live="polite">
        {items.map((it, i) => (
          <span key={i} style={chip}>
            <span style={{ fontFamily: MONO, fontWeight: 600, color: "var(--text-strong)" }}>{it.value}</span>
            <span style={{ color: "var(--text-muted)" }}>{it.label}</span>
          </span>
        ))}
      </div>

      {profile.charts.map((c) => (
        <Chart
          key={c.kind}
          series={c}
          x={x}
          width={width}
          sx={sx}
          cursor={cursor}
          onMove={onMove}
          onLeave={() => onCursor(null)}
        />
      ))}

      <div style={{ position: "relative", height: 14, ...axisText }}>
        {xTicks.map((t) => (
          <span key={t.at} style={{ position: "absolute", left: sx(t.at), transform: "translateX(-50%)" }}>
            {t.label}
          </span>
        ))}
        <span style={{ position: "absolute", left: 0 }}>{profile.xKind === "distance" ? "km" : "time"}</span>
      </div>
    </div>
  );
}

interface ChartProps {
  series: ChartSeries;
  x: number[];
  width: number;
  sx: (v: number) => number;
  cursor: number | null;
  onMove: (e: PointerEvent<SVGSVGElement>) => void;
  onLeave: () => void;
}

function Chart({ series, x, width, sx, cursor, onMove, onLeave }: ChartProps) {
  const { kind, values, domain, invert } = series;
  const h = HEIGHT[kind];
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
    <div style={{ marginTop: 10 }}>
      <div style={chartTitle}>
        {TITLE[kind]} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{UNIT[kind]}</span>
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
          <path d={areaPath(x, values, sx, sy, bottom)} fill={color} fillOpacity={0.18} stroke="none" />
        )}
        <path
          d={linePath(x, values, sx, sy)}
          fill="none"
          stroke={color}
          strokeWidth={kind === "elevation" ? 2 : 1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {cx != null && (
          <g data-cursor="">
            <line x1={cx} x2={cx} y1={0} y2={h} stroke="var(--text-soft)" strokeWidth={1} />
            {cv != null && (
              <circle cx={cx} cy={sy(cv)} r={4} fill={color} stroke="var(--card-bg)" strokeWidth={2} />
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

const chartTitle: CSSProperties = {
  fontSize: FS.xs + 0.5,
  fontWeight: 600,
  color: "var(--text-soft)",
  marginBottom: 3,
};

// A grid, not a wrapping row: how many rows it takes depends only on the width and the
// number of values, never on the values themselves.
const readoutRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
  gap: 4,
  fontSize: FS.xs + 0.5,
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

const chip: CSSProperties = {
  display: "flex",
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
  alignItems: "baseline",
  gap: 4,
  height: 24,
  boxSizing: "border-box",
  padding: "4px 8px",
  borderRadius: R.sm - 2,
  background: "var(--card-bg)",
  border: "1px solid var(--card-grid)",
};
