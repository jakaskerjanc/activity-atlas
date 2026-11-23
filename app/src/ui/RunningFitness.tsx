// Running fitness: each visible run's flat-ground pace at 150 bpm (fitness.ts) as a dot
// against time, faster up, with the rolling median as the accent line through them. A
// sentence under the chart reads the line now against the line a year before. Hovering
// or tapping names the nearest run.

import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { formatDate, formatMonthShort, formatPace, monthIndex } from "../format";
import {
  fitnessComparison,
  fitnessPoints,
  paceTicks,
  REFERENCE_HR,
  ROLLING_DAYS,
  rollingLine,
  timeTicks,
  type LinePoint,
} from "../fitness";
import type { ActivityRecord } from "../types";

/** Paces closer than this (s/km) read as about the same. */
const SAME_PACE_S = 2;
const Y_AXIS_W = 44;
const X_AXIS_H = 20;
const TOP = 8;
/** Room on either side so the end dots aren't cut. */
const PAD_X = 6;
/** How far (px) from a dot the pointer may be and still pick it. */
const PICK_PX = 28;
const DAY_S = 86_400;

// A non-breaking space, so "5:43 /km" never wraps apart.
const km = (pace: number) => `${formatPace(pace)}\u00a0/km`;

export function RunningFitness({
  activities,
  compact = false,
}: {
  /** The visible activities. */
  activities: readonly ActivityRecord[];
  compact?: boolean;
}) {
  const points = useMemo(() => fitnessPoints(activities), [activities]);
  const line = useMemo(() => rollingLine(points), [points]);
  if (points.length === 0) {
    return (
      <p style={status}>
        {activities.some((a) => a.type === "Run")
          ? "No visible run has enough heart rate and distance to measure."
          : "No visible activity is a run."}
      </p>
    );
  }
  const comparison = fitnessComparison(line);
  return (
    <>
      <Chart points={points} line={line} compact={compact} />
      {comparison && (
        <p style={sentence}>
          {standing(comparison.now.pace - comparison.then.pace)} a year ago:{" "}
          <strong style={sentenceValue}>{km(comparison.now.pace)}</strong> now, {km(comparison.then.pace)} in{" "}
          {formatMonthShort(monthIndex(comparison.then.ts))}
        </p>
      )}
    </>
  );
}

/** A pace difference, now minus then (s/km): fewer seconds is faster. */
function standing(diff: number): string {
  if (Math.abs(diff) < SAME_PACE_S) return "About the same as";
  return diff < 0 ? "Faster than" : "Slower than";
}

function Chart({
  points,
  line,
  compact,
}: {
  points: ReturnType<typeof fitnessPoints>;
  line: LinePoint[];
  compact: boolean;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(60, width - Y_AXIS_W - 2 * PAD_X);
  const plotH = compact ? 170 : 220;

  const paces = points.map((p) => p.pace);
  // The axis spans the dots (a little more), with the clock ticks that fall inside it.
  const lo = Math.min(...paces);
  const hi = Math.max(...paces);
  const pad = Math.max(5, (hi - lo) * 0.05);
  const fast = lo - pad;
  const slow = hi + pad;
  const ticks = paceTicks(lo, hi, 4).filter((t) => t >= fast && t <= slow);
  const from = points[0].ts;
  const to = points[points.length - 1].ts;
  const span = Math.max(to - from, DAY_S);
  const xOf = (ts: number) => PAD_X + ((ts - from) / span) * plotW;
  // Faster is up: the fastest tick at the top.
  const yOf = (pace: number) => TOP + ((pace - fast) / (slow - fast)) * plotH;
  const months = timeTicks(from, to, Math.max(2, Math.floor(plotW / 56)));

  // The line, broken where it has no point for longer than its window (a gap in running).
  const path = line
    .map((p, i) => {
      const jump = i === 0 || p.ts - line[i - 1].ts > ROLLING_DAYS * DAY_S;
      return `${jump ? "M" : "L"}${xOf(p.ts).toFixed(1)},${yOf(p.pace).toFixed(1)}`;
    })
    .join("");

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - Y_AXIS_W;
    const y = e.clientY - box.top;
    let best: number | null = null;
    let bestD = PICK_PX;
    points.forEach((p, i) => {
      const d = Math.hypot(xOf(p.ts) - x, yOf(p.pace) - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHover(best);
  };

  const hovered = hover != null ? points[hover] : null;
  const tipX = hovered ? Y_AXIS_W + xOf(hovered.ts) : 0;
  const last = line[line.length - 1];
  const label =
    `Flat-ground pace at ${REFERENCE_HR} bpm for ${points.length} ${points.length === 1 ? "run" : "runs"}, ` +
    `${formatMonthShort(monthIndex(from))} to ${formatMonthShort(monthIndex(to))}` +
    (last ? `; the rolling line ends at ${km(last.pace)}` : "");

  return (
    <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
      <svg
        width={width}
        height={TOP + plotH + X_AXIS_H}
        role="img"
        aria-label={label}
        onPointerMove={pick}
        onPointerDown={pick}
        style={{ display: "block", overflow: "visible", touchAction: "pan-y" }}
      >
        <g transform={`translate(${Y_AXIS_W},0)`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW + 2 * PAD_X} y1={yOf(t)} y2={yOf(t)} style={gridLine} />
              <text x={-8} y={yOf(t) + 3.5} textAnchor="end" style={axisText}>
                {formatPace(t)}
              </text>
            </g>
          ))}
          {months.map((m) => (
            <text key={m.ts} x={xOf(m.ts)} y={TOP + plotH + 14} textAnchor="middle" style={axisText}>
              {m.label}
            </text>
          ))}
          {points.map((p) => (
            <circle key={p.id} cx={xOf(p.ts)} cy={yOf(p.pace)} r={3} style={dot} />
          ))}
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {hovered && (
            <circle
              cx={xOf(hovered.ts)}
              cy={yOf(hovered.pace)}
              r={5}
              fill="var(--text-strong)"
              stroke="var(--bg-raised)"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>
      {hovered && (
        <div
          style={{
            ...tooltip,
            left: tipX,
            top: yOf(hovered.pace),
            transform:
              tipX > width / 2 ? "translate(calc(-100% - 12px), -50%)" : "translate(12px, -50%)",
          }}
        >
          <div style={tipTitle}>{hovered.name}</div>
          <div style={tipNote}>{formatDate(hovered.ts)}</div>
          <div style={tipValue}>
            {km(hovered.pace)} <span style={tipNote}>at {REFERENCE_HR} bpm</span>
          </div>
        </div>
      )}
    </div>
  );
}

const status: CSSProperties = { margin: 0, fontSize: FS.sm, color: "var(--text-muted)" };
const sentence: CSSProperties = { margin: "12px 0 0", fontSize: FS.sm, color: "var(--text-muted)", lineHeight: 1.4 };
const sentenceValue: CSSProperties = { fontFamily: MONO, fontSize: FS.md, fontWeight: 600, color: "var(--text-strong)" };

const dot: CSSProperties = { fill: "var(--text-muted)", opacity: 0.5, pointerEvents: "none" };
const gridLine: CSSProperties = { stroke: "var(--card-grid)", strokeWidth: 1 };
const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS["2xs"],
  fill: "var(--text-muted)",
  pointerEvents: "none",
};

const tooltip: CSSProperties = {
  position: "absolute",
  zIndex: 2,
  pointerEvents: "none",
  whiteSpace: "nowrap",
  padding: "6px 9px",
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.28)",
};
const tipTitle: CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--text-strong)", marginBottom: 2 };
const tipNote: CSSProperties = { fontSize: FS.xs + 0.5, color: "var(--text-muted)" };
const tipValue: CSSProperties = { fontFamily: MONO, fontSize: FS.sm, color: "var(--text)", marginTop: 2 };
