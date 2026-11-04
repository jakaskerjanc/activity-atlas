// The elevation profiles chart (#16): every visible activity's elevation, relative to
// its start, against distance, each drawn as a thin translucent line in its activity
// type's color, so stacked lines darken where you repeat a climb. The lines are
// painted on a canvas (hundreds of paths would be heavy as SVG nodes); the axes, the
// highlighted line under the pointer and its tooltip are SVG and HTML on top.
// Extents and hit testing live in elevationProfiles.ts.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { lengthM, nearestLine, type ProfileChart } from "../elevationProfiles";
import { typeColor } from "../colors";
import { formatDate, formatKm, formatMeters } from "../format";
import { niceTicks } from "../profile";

const Y_AXIS_W = 48;
const X_AXIS_H = 22;
const PLOT_H = 420;
const FALLBACK_WIDTH = 700;
const LINE_ALPHA = 0.3;
/** How close (in pixels, vertically) the pointer must be to pick a line. */
const PICK_PX = 8;
const TIP_WIDTH = 260;

/** Pixel points of a profile on the plot, stopping one point past the right edge. */
function points(profile: readonly number[], chart: ProfileChart, plotW: number): [number, number][] {
  const { step, xMaxM, yMin, yMax } = chart;
  const last = Math.min(profile.length - 1, Math.ceil(xMaxM / step));
  const pts: [number, number][] = [];
  for (let i = 0; i <= last; i++) {
    pts.push([((i * step) / xMaxM) * plotW, ((yMax - profile[i]) / (yMax - yMin)) * PLOT_H]);
  }
  return pts;
}

interface Props {
  chart: ProfileChart;
  /** Every activity type, most common first: a type's color is its place in this list. */
  types: readonly string[];
}

export function ElevationProfiles({ chart, types }: Props) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const plotW = Math.max(60, width - Y_AXIS_W);
  const { lines, step, xMaxM, yMin, yMax } = chart;

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
    ctx.lineWidth = 1.2;
    ctx.lineJoin = "round";
    ctx.globalAlpha = LINE_ALPHA;
    for (const line of lines) {
      ctx.strokeStyle = typeColor(line.type, [...types]);
      ctx.beginPath();
      points(line.profile, chart, plotW).forEach(([x, y], i) =>
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
      );
      ctx.stroke();
    }
  }, [chart, lines, types, plotW]);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }, [lines]);

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
  const yTicks = niceTicks(yMin, yMax, Math.round(PLOT_H / 60));

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
                <text x={-6} y={yOf(m) + 3} textAnchor="end" style={axisText}>
                  {m > 0 ? `+${m}` : m < 0 ? `−${-m}` : "0"} m
                </text>
              </g>
            ))}
            <line x1={0} x2={plotW} y1={PLOT_H + 0.5} y2={PLOT_H + 0.5} style={gridLine} />
            {xTicks.map((km) => (
              <text key={km} x={xOf(km * 1000)} y={PLOT_H + 15} textAnchor="middle" style={axisText}>
                {km} km
              </text>
            ))}
            {hovered && (
              <polyline
                clipPath="url(#profiles-plot)"
                points={points(hovered.profile, chart, plotW)
                  .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
                  .join(" ")}
                style={{
                  fill: "none",
                  stroke: typeColor(hovered.type, [...types]),
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
              {hovered.type} · {formatDate(hovered.ts)} · {formatKm(lengthM(hovered, step))} km ·{" "}
              {elevationLabel(hovered.profile)}
            </div>
          </div>
        )}
      </div>
      <div style={legendRow}>
        {legend.map(([type, n]) => (
          <span key={type} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ ...swatch, background: typeColor(type, [...types]) }} />
            {type} {n}
          </span>
        ))}
      </div>
      <p style={note}>
        Each line is one activity's elevation from its start. Lines are see-through, so climbs
        you repeat darken where they stack up; hover a line to see which activity it is.
        {chart.cut > 0 &&
          ` ${chart.cut} longer than ${xKm} km run past the right edge and are cut there.`}
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

const gridLine: CSSProperties = { stroke: "var(--divider)", strokeWidth: 1 };

const startLine: CSSProperties = {
  stroke: "var(--text-muted)",
  strokeWidth: 1,
  strokeDasharray: "3 3",
};

const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  fill: "var(--text-muted)",
};

const muted: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-muted)",
};

const note: CSSProperties = { ...muted, margin: "10px 0 0" };

const legendRow: CSSProperties = {
  ...muted,
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  marginTop: 10,
};

const swatch: CSSProperties = { width: 10, height: 3, borderRadius: 2 };

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
