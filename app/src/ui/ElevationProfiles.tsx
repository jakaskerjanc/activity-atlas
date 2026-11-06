// The elevation profiles chart (#16): every visible activity's elevation, relative to
// its start, against distance, each drawn as a thin translucent line in its activity
// type's color, so stacked lines darken where you repeat a climb. The lines are
// painted on a canvas (hundreds of paths would be heavy as SVG nodes); the axes, the
// highlighted line under the pointer and its tooltip are SVG and HTML on top.
// Extents and hit testing live in elevationProfiles.ts.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { elevationAxis, lengthM, lineAlpha, nearestLine, type ProfileChart } from "../elevationProfiles";
import { useMediaQuery } from "./useMediaQuery";
import { typeColor } from "../colors";
import { formatDate, formatKm, formatMeters } from "../format";
import { niceTicks } from "../profile";
import type { Theme } from "../types";

const Y_AXIS_W = 52;
const X_AXIS_H = 24;
const FALLBACK_WIDTH = 700;
/** How close (in pixels, vertically) the pointer must be to pick a line. */
const PICK_PX = 8;
const TIP_WIDTH = 260;

interface Plot {
  w: number;
  h: number;
  /** The y domain: rounded out to whole ticks (elevationAxis). */
  lo: number;
  hi: number;
}

/** Pixel points of a profile on the plot, stopping one point past the right edge. */
function points(profile: readonly number[], chart: ProfileChart, plot: Plot): [number, number][] {
  const { step, xMaxM } = chart;
  const last = Math.min(profile.length - 1, Math.ceil(xMaxM / step));
  const pts: [number, number][] = [];
  for (let i = 0; i <= last; i++) {
    pts.push([((i * step) / xMaxM) * plot.w, ((plot.hi - profile[i]) / (plot.hi - plot.lo)) * plot.h]);
  }
  return pts;
}

interface Props {
  chart: ProfileChart;
  /** Every activity type in the filter's order (most activities first, over all data), so
   * the legend keeps one order whatever the filter shows. */
  order?: readonly string[];
  theme?: Theme;
  /** A phone: a shorter plot. */
  compact?: boolean;
}

export function ElevationProfiles({ chart, order = [], theme = "dark", compact = false }: Props) {
  const canHover = useMediaQuery("(hover: hover)");
  const [boxRef, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const plotW = Math.max(60, width - Y_AXIS_W);
  const PLOT_H = compact ? 280 : 380;
  const { lines, step, xMaxM } = chart;
  const axis = useMemo(
    () => elevationAxis(chart.yMin, chart.yMax, Math.floor(PLOT_H / 30)),
    [chart.yMin, chart.yMax, PLOT_H],
  );
  const yMin = axis.lo;
  const yMax = axis.hi;
  const plot: Plot = { w: plotW, h: PLOT_H, lo: yMin, hi: yMax };

  // The hover is an index into `lines`: a new chart (the filter changed) drops it, so the
  // tooltip can't name a different activity than the one under the pointer.
  useEffect(() => setHover(null), [chart]);

  const xOf = (m: number) => (m / xMaxM) * plotW;
  const yOf = (m: number) => ((yMax - m) / (yMax - yMin)) * PLOT_H;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(plotW * dpr);
    canvas.height = Math.round(PLOT_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, plotW, PLOT_H);
    // Fewer lines draw bolder, so one isolated month still reads (lineAlpha).
    ctx.lineWidth = lines.length < 20 ? 1.8 : 1.2;
    ctx.lineJoin = "round";
    ctx.globalAlpha = lineAlpha(lines.length);
    for (const line of lines) {
      ctx.strokeStyle = typeColor(line.type, theme);
      ctx.beginPath();
      points(line.profile, chart, { w: plotW, h: PLOT_H, lo: yMin, hi: yMax }).forEach(([x, y], i) =>
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
      );
      ctx.stroke();
    }
  }, [chart, lines, theme, plotW, PLOT_H, yMin, yMax]);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
    // The filter's type order, not this set's counts, so the legend never reshuffles.
    const rank = (t: string) => {
      const i = order.indexOf(t);
      return i < 0 ? order.length : i;
    };
    return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }, [lines, order]);

  const track = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    const perPx = (yMax - yMin) / PLOT_H;
    const index = nearestLine(chart, (px / plotW) * xMaxM, yMax - py * perPx, PICK_PX * perPx);
    setHover(index == null ? null : { index, x: px, y: py });
  };

  const hovered = hover ? lines[hover.index] : null;
  const xKm = xMaxM / 1000;
  const xTicks = niceTicks(0, xKm, Math.max(2, Math.floor(plotW / 80)));
  const yTicks = axis.ticks;

  return (
    <div ref={boxRef}>
      <div style={{ position: "relative", height: PLOT_H + X_AXIS_H }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Elevation of ${lines.length} ${lines.length === 1 ? "activity" : "activities"} against distance, overlaid`}
          onPointerMove={track}
          onPointerDown={track}
          onPointerLeave={() => setHover(null)}
          style={{
            position: "absolute",
            left: Y_AXIS_W,
            top: 0,
            width: plotW,
            height: PLOT_H,
            cursor: hovered ? "crosshair" : "default",
            touchAction: "pan-y",
          }}
        />
        <svg
          width="100%"
          height={PLOT_H + X_AXIS_H}
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
          aria-hidden="true"
        >
          <defs>
            <clipPath id="profiles-plot">
              <rect x={0} y={0} width={plotW} height={PLOT_H} />
            </clipPath>
          </defs>
          <g transform={`translate(${Y_AXIS_W},0)`}>
            {yTicks.map((m) => (
              <g key={m}>
                <line
                  x1={0}
                  x2={plotW}
                  y1={yOf(m)}
                  y2={yOf(m)}
                  style={m === 0 ? startLine : gridLine}
                />
                <text x={-8} y={yOf(m) + 3.5} textAnchor="end" style={axisText}>
                  {m > 0 ? `+${m}` : m < 0 ? `−${-m}` : "0"} m
                </text>
              </g>
            ))}
            <line x1={0} x2={plotW} y1={PLOT_H + 0.5} y2={PLOT_H + 0.5} style={gridLine} />
            {xTicks.map((km, i) => (
              <text
                key={km}
                x={xOf(km * 1000)}
                y={PLOT_H + 16}
                textAnchor={i === 0 ? "start" : km * 1000 >= xMaxM ? "end" : "middle"}
                style={axisText}
              >
                {km} km
              </text>
            ))}
            {hovered && (
              <polyline
                clipPath="url(#profiles-plot)"
                points={points(hovered.profile, chart, plot)
                  .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
                  .join(" ")}
                style={{
                  fill: "none",
                  stroke: typeColor(hovered.type, theme),
                  strokeWidth: 2.5,
                  strokeLinejoin: "round",
                }}
              />
            )}
          </g>
        </svg>
        {hover && hovered && (
          <div
            style={{ ...tooltip, left: tipCenter(Y_AXIS_W + hover.x, width), top: hover.y }}
          >
            <div style={tipName}>{hovered.name}</div>
            <div style={muted}>
              {hovered.type} on {formatDate(hovered.ts)}
            </div>
            <div style={{ ...muted, fontFamily: MONO, marginTop: 2 }}>
              {formatKm(lengthM(hovered, step))} km, {elevationLabel(hovered.profile)}
            </div>
          </div>
        )}
      </div>
      <div style={legendRow}>
        {legend.map(([type, n]) => (
          <span key={type} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ ...swatch, background: typeColor(type, theme) }} />
            {type}
            <span style={{ fontFamily: MONO, color: "var(--text-muted)" }}>{n}</span>
          </span>
        ))}
      </div>
      <p style={note}>
        Climbs you repeat stand out where lines stack up. {canHover ? "Hover" : "Tap"} a line to name it.
        {chart.cut > 0 &&
          ` ${chart.cut} ${chart.cut === 1 ? "activity runs" : "activities run"} past ${xKm} km and ${chart.cut === 1 ? "is" : "are"} cut at the right edge.`}
      </p>
    </div>
  );
}

/** The tooltip's centre: over the pointer, but kept inside the chart's `width`. */
function tipCenter(x: number, width: number): number {
  const half = Math.min(TIP_WIDTH, width) / 2;
  return Math.min(Math.max(x, half), width - half);
}

/** "+804 m high point" / "−120 m low point", relative to the start. */
function elevationLabel(profile: readonly number[]): string {
  const high = Math.max(...profile);
  const low = Math.min(...profile);
  return high >= -low
    ? `+${formatMeters(high)} m high point`
    : `−${formatMeters(-low)} m low point`;
}

const gridLine: CSSProperties = { stroke: "var(--card-grid)", strokeWidth: 1 };

const startLine: CSSProperties = {
  stroke: "var(--text-muted)",
  strokeWidth: 1,
  strokeDasharray: "3 3",
};

const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS["2xs"],
  fill: "var(--text-muted)",
};

const muted: CSSProperties = {
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
};

const note: CSSProperties = { ...muted, margin: "10px 0 0" };

const legendRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 12,
  fontSize: FS.sm,
  color: "var(--text-soft)",
};

const swatch: CSSProperties = { width: 14, height: 3, borderRadius: 2 };

const tooltip: CSSProperties = {
  position: "absolute",
  zIndex: 2,
  transform: "translate(-50%, calc(-100% - 10px))",
  pointerEvents: "none",
  boxSizing: "border-box",
  width: "max-content",
  maxWidth: `min(${TIP_WIDTH}px, 100%)`,
  padding: "6px 9px",
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.28)",
};

const tipName: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--text-strong)",
  marginBottom: 2,
};
