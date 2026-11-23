// Running fitness: each visible run's flat-ground pace at 150 bpm corrected for climbing
// (fitness.ts) as a dot against time, faster up, with the rolling 3-month mean as the
// accent line through them over a faint ±1 standard-error band. A sentence under the
// chart reads the line now against the line a year before; a note says what the number
// is. Hovering or tapping names the nearest run, with its value before the correction.

import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { formatDate, formatMonthShort, formatPace, monthIndex } from "../format";
import {
  climbCorrection,
  fitnessComparison,
  fitnessPoints,
  paceTicks,
  REFERENCE_HR,
  rollingLine,
  timeTicks,
  type FitnessPoint,
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
  all,
  compact = false,
}: {
  /** The visible activities. */
  activities: readonly ActivityRecord[];
  /** Every activity, visible or not: the climb correction is fitted over all the runs, so the filter doesn't move it. */
  all: readonly ActivityRecord[];
  compact?: boolean;
}) {
  const slope = useMemo(() => climbCorrection(all), [all]);
  const points = useMemo(() => fitnessPoints(activities, slope), [activities, slope]);
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
      <p style={note}>
        An estimate from pace, heart rate and climbing, not a VO2max.{" "}
        {slope > 0
          ? `Hillier runs still read slower after the grade adjustment, so each run is credited ${slope.toFixed(1)}\u00a0s/km per metre climbed per km, fitted from your runs.`
          : "Too few runs yet to fit a climb correction, so the values aren't corrected for climbing."}
      </p>
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
  points: FitnessPoint[];
  line: LinePoint[][];
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

  // The line, one piece per unbroken run of points (rollingLine leaves gaps unbridged),
  // and its ±1 standard-error band; a lone point is drawn as a dot of the line's colour.
  const xy = (ts: number, pace: number) => `${xOf(ts).toFixed(1)},${yOf(pace).toFixed(1)}`;
  const path = line.map((seg) => seg.map((p, i) => `${i === 0 ? "M" : "L"}${xy(p.ts, p.pace)}`).join("")).join("");
  const band = line
    .filter((seg) => seg.length > 1)
    .map(
      (seg) =>
        "M" +
        seg.map((p) => xy(p.ts, p.pace - p.se)).join("L") +
        "L" +
        [...seg].reverse().map((p) => xy(p.ts, p.pace + p.se)).join("L") +
        "Z",
    )
    .join("");
  const lone = line.filter((seg) => seg.length === 1).map((seg) => seg[0]);

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
  const last = line[line.length - 1]?.[line[line.length - 1].length - 1];
  const label =
    `Flat-ground pace at ${REFERENCE_HR} bpm, corrected for climbing, for ${points.length} ${points.length === 1 ? "run" : "runs"}, ` +
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
          <path d={band} fill="var(--accent)" opacity={0.16} pointerEvents="none" />
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {lone.map((p) => (
            <circle key={p.ts} cx={xOf(p.ts)} cy={yOf(p.pace)} r={2.5} fill="var(--accent)" pointerEvents="none" />
          ))}
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
          <div style={tipNote}>{Math.round(hovered.climb)}&nbsp;m climbed per km</div>
          {hovered.rawPace !== hovered.pace && (
            <div style={tipNote}>{km(hovered.rawPace)} before the climb correction</div>
          )}
        </div>
      )}
    </div>
  );
}

const status: CSSProperties = { margin: 0, fontSize: FS.sm, color: "var(--text-muted)" };
const sentence: CSSProperties = { margin: "12px 0 0", fontSize: FS.sm, color: "var(--text-muted)", lineHeight: 1.4 };
const note: CSSProperties = { margin: "6px 0 0", fontSize: FS.xs, color: "var(--text-muted)", lineHeight: 1.4 };
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
