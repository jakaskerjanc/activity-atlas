// The elevation heatmap (#16): every visible activity's elevation, relative to its
// start, against distance, overlaid in one grid. Cells are painted on a canvas (a few
// thousand of them would be heavy as SVG nodes), in the theme's strongest heat color
// (--heat-4, as the calendar's busiest days) at an opacity that grows on a log scale
// with how many outings pass through; the axes are SVG on top.
// Binning lives in elevationHeatmap.ts.

import { useEffect, useRef, type CSSProperties } from "react";
import { ACCENT, MONO } from "./theme";
import type { Theme } from "../types";
import { useElementWidth } from "./useElementWidth";
import { cellAlpha, type HeatmapGrid } from "../elevationHeatmap";
import { niceTicks } from "../profile";

const Y_AXIS_W = 48;
const X_AXIS_H = 22;
const PLOT_H = 260;
const FALLBACK_WIDTH = 700;

/** "#rrggbb" -> [r, g, b]; the accent for anything else. */
function rgb(hex: string): number[] {
  const h = /^#[0-9a-f]{6}$/i.test(hex) ? hex : ACCENT;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

interface Props {
  grid: HeatmapGrid;
  /** Repaints the canvas when the theme flips (a canvas can't follow a CSS variable). */
  theme: Theme;
}

export function ElevationHeatmap({ grid, theme }: Props) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const plotW = Math.max(60, width - Y_AXIS_W);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(plotW * dpr);
    canvas.height = Math.round(PLOT_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, plotW, PLOT_H);
    const [R, G, B] = rgb(getComputedStyle(canvas).getPropertyValue("--heat-4").trim());
    const cw = plotW / grid.cols;
    const ch = PLOT_H / grid.rows;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const a = cellAlpha(grid.counts[r * grid.cols + c], grid.max);
        if (a === 0) continue;
        ctx.fillStyle = `rgba(${R},${G},${B},${a.toFixed(3)})`;
        // A hair of overlap, so neighbouring cells don't show seams.
        ctx.fillRect(c * cw, r * ch, cw + 0.5, ch + 0.5);
      }
    }
  }, [grid, plotW, theme]);

  const xKm = grid.xMaxM / 1000;
  const xOf = (km: number) => (km / xKm) * plotW;
  const yOf = (m: number) => ((grid.yMax - m) / (grid.yMax - grid.yMin)) * PLOT_H;
  const xTicks = niceTicks(0, xKm, Math.max(2, Math.floor(plotW / 80)));
  const yTicks = niceTicks(grid.yMin, grid.yMax, 4);

  return (
    <div ref={boxRef}>
      <div style={{ position: "relative", height: PLOT_H + X_AXIS_H }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Elevation of ${grid.profiles} ${grid.profiles === 1 ? "activity" : "activities"} against distance, overlaid`}
          style={{ position: "absolute", left: Y_AXIS_W, top: 0, width: plotW, height: PLOT_H }}
        />
        <svg
          width="100%"
          height={PLOT_H + X_AXIS_H}
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
          aria-hidden="true"
        >
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
              <text key={km} x={xOf(km)} y={PLOT_H + 15} textAnchor="middle" style={axisText}>
                {km} km
              </text>
            ))}
          </g>
        </svg>
      </div>
      <p style={note}>
        {grid.profiles} {grid.profiles === 1 ? "activity" : "activities"}, each measured from its
        start. The stronger the color, the more of them pass there (log scale), so climbs you
        repeat stand out.
        {grid.cut > 0 &&
          ` ${grid.cut} run past the ${xKm} km or elevation edges and are cut there.`}
      </p>
    </div>
  );
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

const note: CSSProperties = {
  margin: "10px 0 0",
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-muted)",
};
