// Running fitness: the rolling 3-month mean of each visible run's flat-ground pace at
// 150 bpm, corrected for climbing (fitness.ts). A lead line, like the other cards', gives
// the line's latest value, the change since a year earlier and the best value; the chart is
// the line alone, faster up, with its best and latest points labelled and its breaks
// bridged by a faint dotted connector. Hovering or tapping snaps a crosshair to the
// nearest week: its value and how many runs it averages, or why the line has none.

import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { formatDate, formatMonthShort, formatPace, monthIndex } from "../format";
import {
  bestPoint,
  climbCorrection,
  fitnessComparison,
  fitnessPoints,
  LINE_STEP_DAYS,
  lineDates,
  lineGaps,
  noLineReason,
  paceTicks,
  REFERENCE_HR,
  ROLLING_MIN_RUNS,
  rollingLine,
  timeTicks,
  type FitnessPoint,
  type LinePoint,
} from "../fitness";
import type { ActivityRecord } from "../types";

/** Paces closer than this (s/km) read as about the same. */
const SAME_PACE_S = 2;
const Y_AXIS_W = 40;
const X_AXIS_H = 20;
/** Room above the line for the label over its best point. */
const TOP = 24;
const PAD_X = 6;
/** Room right of the plot for the label at the line's end. */
const END_LABEL_W = { wide: 64, compact: 38 };
const LABEL_FS = FS.xs;
/** Rough width of a label character, for keeping labels apart and inside the card. */
const CHAR_W = 6.4;
const DAY_S = 86_400;

// A non-breaking space, so "5:43 /km" never wraps apart.
const km = (pace: number) => `${formatPace(pace)}\u00a0/km`;

export function RunningFitness({
  activities,
  all,
  compact = false,
  now = Date.now() / 1000,
}: {
  /** The visible activities. */
  activities: readonly ActivityRecord[];
  /** Every activity, visible or not: the climb correction is fitted over all the runs, so the filter doesn't move it. */
  all: readonly ActivityRecord[];
  compact?: boolean;
  /** Epoch seconds: whether the line's latest value is this week's. */
  now?: number;
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
  const latest = line.length > 0 ? line[line.length - 1][line[line.length - 1].length - 1] : null;
  const best = bestPoint(line);
  const comparison = fitnessComparison(line);
  return (
    <>
      {latest ? (
        <Headline latest={latest} best={best} comparison={comparison} now={now} />
      ) : (
        <p style={{ ...status, marginBottom: 12 }}>
          Not enough runs yet for a 3-month average: it takes {ROLLING_MIN_RUNS} within 3 months.
        </p>
      )}
      {latest && <Chart points={points} line={line} best={best} latest={latest} compact={compact} />}
      <p style={note}>
        An estimate from pace, heart rate and climbing, not VO2max.{" "}
        {slope > 0
          ? `Hillier runs still read slower after the grade adjustment, so each run is credited ${slope.toFixed(1)}\u00a0s/km per metre climbed per km, fitted from your runs.`
          : "Too few runs yet to fit a climb correction, so the values aren't corrected for climbing."}
      </p>
    </>
  );
}

function Headline({
  latest,
  best,
  comparison,
  now,
}: {
  latest: LinePoint;
  best: LinePoint | null;
  comparison: { now: LinePoint; then: LinePoint } | null;
  now: number;
}) {
  // The line ends at the newest run; a week on without one, the value is that run's.
  const stale = latest.ts < now - LINE_STEP_DAYS * DAY_S;
  const diff = comparison ? comparison.now.pace - comparison.then.pace : null;
  const secs = diff == null ? 0 : Math.round(Math.abs(diff));
  return (
    <p style={lead}>
      <strong style={leadValue}>{formatPace(latest.pace)}</strong>
      {"\u00a0/km"}
      {stale ? ` as of ${shortDate(latest.ts, now)}` : " now"}
      {diff != null && (
        <>
          {", "}
          <span title={`${km(comparison!.then.pace)} in ${formatMonthShort(monthIndex(comparison!.then.ts))}`}>
            {Math.abs(diff) < SAME_PACE_S
              ? "about the same as a year ago"
              : `${secs}\u00a0s/km ${diff < 0 ? "faster" : "slower"} than a year ago`}
          </span>
        </>
      )}
      {best && ` · best ${km(best.pace)} in ${formatMonthShort(monthIndex(best.ts))}`}
    </p>
  );
}

/** "Oct 25" this year, "Oct 25, 2025" before. */
function shortDate(ts: number, now: number): string {
  const full = formatDate(ts);
  return new Date(ts * 1000).getUTCFullYear() === new Date(now * 1000).getUTCFullYear()
    ? full.replace(/, \d{4}$/, "")
    : full;
}

/** A label on the chart, in plot coordinates: its text, anchor point and box. */
interface Label {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}
function labelBox(l: Label): { x0: number; x1: number; y0: number; y1: number } {
  const w = l.text.length * CHAR_W;
  const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
  return { x0, x1: x0 + w, y0: l.y - LABEL_FS, y1: l.y + 2 };
}
const overlaps = (a: Label, b: Label) => {
  const p = labelBox(a);
  const q = labelBox(b);
  return p.x0 < q.x1 + 4 && q.x0 < p.x1 + 4 && p.y0 < q.y1 && q.y0 < p.y1;
};

function Chart({
  points,
  line,
  best,
  latest,
  compact,
}: {
  points: FitnessPoint[];
  line: LinePoint[][];
  best: LinePoint | null;
  latest: LinePoint;
  compact: boolean;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<number | null>(null);
  const endW = END_LABEL_W[compact ? "compact" : "wide"];
  const plotW = Math.max(60, width - Y_AXIS_W - 2 * PAD_X - endW);
  const plotH = compact ? 150 : 200;

  const dates = useMemo(() => lineDates(points), [points]);
  const byDate = useMemo(() => new Map(line.flat().map((p) => [p.ts, p])), [line]);
  const gaps = lineGaps(line);

  // The axis spans the line (a little more).
  const values = [...byDate.values()].map((p) => p.pace);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(5, (hi - lo) * 0.08);
  const fast = lo - pad;
  const slow = hi + pad;
  const ticks = paceTicks(lo, hi, compact ? 3 : 4).filter((t) => t >= fast && t <= slow);
  const from = points[0].ts;
  const to = points[points.length - 1].ts;
  const span = Math.max(to - from, DAY_S);
  const xOf = (ts: number) => PAD_X + ((ts - from) / span) * plotW;
  // Faster is up: the fastest tick at the top.
  const yOf = (pace: number) => TOP + ((pace - fast) / (slow - fast)) * plotH;
  const months = timeTicks(from, to, Math.max(2, Math.floor(plotW / 56)));

  const xy = (p: LinePoint) => `${xOf(p.ts).toFixed(1)},${yOf(p.pace).toFixed(1)}`;
  const path = line.map((seg) => seg.map((p, i) => `${i === 0 ? "M" : "L"}${xy(p)}`).join("")).join("");
  const connectors = gaps.map((g) => `M${xy(g.from)}L${xy(g.to)}`).join("");
  // A piece of one point has no length to stroke: drawn as a dot of the line's colour.
  const lone = line.filter((seg) => seg.length === 1).map((seg) => seg[0]);

  // Direct labels: the latest value in the room right of the line's end, the best above
  // its point, kept inside the plot; the best is left out when it reads the same as the
  // latest, or when it would run into the end label (the headline gives it anyway).
  const distinctBest = best && formatPace(best.pace) !== formatPace(latest.pace) ? best : null;
  const nowLabel: Label = {
    text: compact ? formatPace(latest.pace) : `Now ${formatPace(latest.pace)}`,
    x: xOf(latest.ts) + 8,
    y: yOf(latest.pace) + 3.5,
    anchor: "start",
  };
  let bestLabel: Label | null = null;
  if (distinctBest) {
    const text = compact ? formatPace(distinctBest.pace) : `Best ${formatPace(distinctBest.pace)}`;
    const half = (text.length * CHAR_W) / 2;
    const x = Math.min(Math.max(xOf(distinctBest.ts), half), PAD_X + plotW - half);
    const candidate: Label = { text, x, y: yOf(distinctBest.pace) - 9, anchor: "middle" };
    if (!overlaps(candidate, nowLabel)) bestLabel = candidate;
  }

  const track = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - Y_AXIS_W;
    if (x < 0 || x > PAD_X * 2 + plotW || dates.length === 0) {
      setHover(null);
      return;
    }
    // Snap to the nearest week the line is evaluated at.
    const ts = from + ((x - PAD_X) / plotW) * span;
    let i = 0;
    for (let k = 1; k < dates.length; k++) if (Math.abs(dates[k] - ts) < Math.abs(dates[i] - ts)) i = k;
    setHover(dates[i]);
  };

  const hovered = hover != null ? (byDate.get(hover) ?? null) : null;
  const reason = hover != null && !hovered ? noLineReason(points, hover) : null;
  const cursorX = hover == null ? 0 : Y_AXIS_W + xOf(hover);
  const tipLeft = cursorX > Y_AXIS_W + plotW / 2;

  const label =
    `The 3-month average of flat-ground pace at ${REFERENCE_HR} bpm, corrected for climbing, over ${points.length} ${points.length === 1 ? "run" : "runs"}, ` +
    `${formatMonthShort(monthIndex(from))} to ${formatMonthShort(monthIndex(to))}` +
    `; now ${km(latest.pace)}` +
    (distinctBest ? `, best ${km(distinctBest.pace)} in ${formatMonthShort(monthIndex(distinctBest.ts))}` : "") +
    (gaps.length > 0 ? `; ${gaps.length} ${gaps.length === 1 ? "break" : "breaks"} with too few runs` : "");

  return (
    <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
      <svg
        width={width}
        height={TOP + plotH + X_AXIS_H}
        role="img"
        aria-label={label}
        onPointerMove={track}
        onPointerDown={track}
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
          {hover != null && (
            <line x1={xOf(hover)} x2={xOf(hover)} y1={TOP - 6} y2={TOP + plotH} style={cursorLine} />
          )}
          {connectors && (
            <path
              d={connectors}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5}
              strokeDasharray="2 4"
              strokeLinecap="round"
              opacity={0.55}
              pointerEvents="none"
            />
          )}
          <path
            d={path}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            pointerEvents="none"
          />
          {lone.map((p) => (
            <circle key={p.ts} cx={xOf(p.ts)} cy={yOf(p.pace)} r={2.5} fill="var(--accent)" pointerEvents="none" />
          ))}
          {[bestLabel && distinctBest, latest].map(
            (p) =>
              p && (
                <circle
                  key={`mark-${p.ts}`}
                  cx={xOf(p.ts)}
                  cy={yOf(p.pace)}
                  r={3.5}
                  fill="var(--accent)"
                  stroke="var(--bg-raised)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
              ),
          )}
          {[bestLabel, nowLabel].map(
            (l) =>
              l && (
                <text key={l.text} x={l.x} y={l.y} textAnchor={l.anchor} style={directLabel}>
                  {l.text}
                </text>
              ),
          )}
          {hovered && (
            <circle
              cx={xOf(hovered.ts)}
              cy={yOf(hovered.pace)}
              r={4.5}
              fill="var(--text-strong)"
              stroke="var(--bg-raised)"
              strokeWidth={2}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>
      {hover != null && (
        <div
          style={{
            ...tooltip,
            top: TOP,
            left: cursorX,
            transform: tipLeft ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
          }}
        >
          {hovered ? (
            <>
              <div style={tipTitle}>{formatDate(hovered.ts)}</div>
              <div style={tipValue}>
                {km(hovered.pace)} <span style={tipNote}>at {REFERENCE_HR} bpm</span>
              </div>
              <div style={tipNote}>
                3-month average of {hovered.runs} {hovered.runs === 1 ? "run" : "runs"}
              </div>
            </>
          ) : reason?.kind === "no-runs" ? (
            <>
              <div style={tipTitle}>
                {reason.lastRun != null && reason.nextRun != null
                  ? `No runs ${formatDate(reason.lastRun)} – ${formatDate(reason.nextRun)}`
                  : "No runs yet"}
              </div>
              <div style={tipNote}>A gap in the line: no 3-month average here</div>
            </>
          ) : (
            reason && (
              <>
                <div style={tipTitle}>Too few runs for a 3-month average</div>
                <div style={tipNote}>
                  {reason.runs} {reason.runs === 1 ? "run" : "runs"} in the 3 months to {formatDate(hover)}; it takes{" "}
                  {ROLLING_MIN_RUNS}
                </div>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

const status: CSSProperties = { margin: 0, fontSize: FS.sm, color: "var(--text-muted)" };
const note: CSSProperties = { margin: "10px 0 0", fontSize: FS.xs, color: "var(--text-muted)", lineHeight: 1.45 };

// As the other cards' lead line (Year against year): the value in strong mono, the rest muted.
const lead: CSSProperties = { margin: "0 0 12px", fontSize: FS.sm, color: "var(--text-muted)", lineHeight: 1.4 };
const leadValue: CSSProperties = { fontFamily: MONO, fontSize: FS.md, fontWeight: 600, color: "var(--text-strong)" };

const gridLine: CSSProperties = { stroke: "var(--card-grid)", strokeWidth: 1 };
const cursorLine: CSSProperties = { stroke: "var(--text-muted)", strokeWidth: 1, opacity: 0.6 };
const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS["2xs"],
  fill: "var(--text-muted)",
  pointerEvents: "none",
};
const directLabel: CSSProperties = {
  fontSize: LABEL_FS,
  fontWeight: 600,
  fill: "var(--text-soft)",
  fontVariantNumeric: "tabular-nums",
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
