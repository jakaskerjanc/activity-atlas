// The selected activity's charts, stacked on one x axis (distance, else time):
// elevation, heart rate, then pace (foot types) or speed. Each chart is its own SVG
// with its own y axis — never two scales on one plot. Pointer over any chart sets the
// shared cursor (a sample index); the readout above shows the values there and the
// map draws a marker at the same sample (MapView). Model: ../profile.ts.

import type { CSSProperties, PointerEvent } from "react";
import { MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import {
  areaPath,
  linePath,
  nearestIndex,
  niceTicks,
  paceTicks,
  readout,
  type ChartKind,
  type ChartSeries,
  type Profile,
} from "../profile";
import { formatClock, formatPace } from "../format";
import type { DetailState } from "../detail";
import type { DetailFile } from "../types";

interface Props {
  detail: DetailFile;
  profile: Profile;
  type: string;
  cursor: number | null;
  onCursor: (i: number | null) => void;
}

const HEIGHT: Record<ChartKind, number> = { elevation: 84, hr: 52, pace: 52, speed: 52 };
const TITLE: Record<ChartKind, string> = {
  elevation: "Elevation · m",
  hr: "Heart rate · bpm",
  pace: "Pace · /km",
  speed: "Speed · km/h",
};
// Validated with the dataviz palette checker against both panel surfaces: accent,
// violet and cyan stay apart under colour-vision deficiency. Each chart is labelled,
// so identity never rests on colour alone.
const COLOR: Record<ChartKind, string> = {
  elevation: "var(--accent)",
  hr: "#b07cff",
  pace: "#3fb8e0",
  speed: "#3fb8e0",
};

/** Left gutter for y tick labels, right gutter so the last point isn't clipped. */
const PAD_L = 34;
const PAD_R = 4;
const PAD_Y = 4;
const FALLBACK_WIDTH = 400;

const HINT = "Hover the chart or the route";

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

  const items = cursor == null ? null : readout(detail, profile, cursor, type);
  const xTicks =
    profile.xKind === "distance"
      ? niceTicks(x0 / 1000, x1 / 1000, 4).map((km) => ({ at: km * 1000, label: `${km}` }))
      : niceTicks(x0, x1, 4).map((s) => ({ at: s, label: formatClock(s) }));

  return (
    <div ref={ref} style={{ marginTop: 12 }}>
      <div style={readoutRow} aria-live="polite">
        {items ? (
          items.map((it) => (
            <span key={it.label}>
              <span style={{ color: "var(--text-strong)" }}>{it.value}</span>{" "}
              <span style={{ color: "var(--text-muted)" }}>{it.label}</span>
            </span>
          ))
        ) : (
          <span style={{ color: "var(--text-muted)" }}>{HINT}</span>
        )}
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
  const ticks = kind === "pace" ? paceTicks(lo, hi) : niceTicks(lo, hi, kind === "elevation" ? 3 : 2);
  const cx = cursor == null ? null : sx(x[cursor]);
  const cv = cursor == null ? null : values[cursor];

  return (
    <div style={{ marginTop: 6 }}>
      <div style={chartTitle}>{TITLE[kind]}</div>
      <svg
        width={width}
        height={h}
        style={{ display: "block", touchAction: "pan-y", cursor: "crosshair" }}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={onLeave}
        role="img"
        aria-label={TITLE[kind]}
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
  fontSize: 9,
  color: "var(--text-muted)",
};

const chartTitle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  marginBottom: 2,
};

const readoutRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px 12px",
  minHeight: 16,
  fontFamily: MONO,
  fontSize: 11,
};
