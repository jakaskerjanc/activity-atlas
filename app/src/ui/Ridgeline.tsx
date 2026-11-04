// The climbing ridgeline (#20): one ridge per month of the date range, oldest at the
// top. Along each ridge x is the day of the month and the height is that day's
// elevation gain; taller ridges overlap the row above, like a joyplot. Dots on the
// baseline mark days with an activity, and every row shows the month's total gain.
// Clicking a row isolates that month through the Activity filter (App owns the filter);
// clicking it again restores the range from before. Plain SVG, like the activity
// charts. Numbers live in ridgeline.ts.

import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ACCENT, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import {
  dayX,
  formatGain,
  ridgeHeight,
  ridgeLabel,
  ridgePaths,
  type ClimbingRidgeline,
  type MonthRidge,
} from "../ridgeline";
import { formatMeters } from "../format";

/** Row pitch, and so each row's tap target. */
export const ROW = 32;
/** Height of the tallest ridge in view: it overlaps the 1.5 rows above it. */
const MAX_RIDGE = ROW * 2.5;
/** Gap between a row's baseline and the bottom of its band, room for label descenders. */
const BASE_GAP = 8;
const LABEL_W = 74;
const GAIN_W = 56;
/** Rows shown before the chart scrolls (about a year). */
const VIEW_ROWS = 12;
const FALLBACK_WIDTH = 700;
/** Kept clear on the right for the scroller's scrollbar, so it never covers the gain labels. */
const SCROLL_GUTTER = 10;
const AXIS_H = 22;

/** Day ticks on the axis. */
const DAY_TICKS = [1, 8, 15, 22, 29];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Props {
  ridgeline: ClimbingRidgeline;
  /** The month isolated by a click, while the range is still just that month. */
  isolatedMonth: number | null;
  onPickMonth: (month: number) => void;
}

export function Ridgeline({ ridgeline, isolatedMonth, onPickMonth }: Props) {
  const { ridges, maxM } = ridgeline;
  const [boxRef, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [hover, setHover] = useState<number | null>(null);
  // useId's characters aren't all safe inside url(#…).
  const fillId = `ridge-fill-${useId().replace(/[^\w-]/g, "")}`;

  const plotW = Math.max(ROW, width - SCROLL_GUTTER - LABEL_W - GAIN_W);
  // The middle of a (1-based) day.
  const xOf = (day: number) => dayX(day - 0.5, plotW);

  const rows = useMemo(() => {
    // Room above the first rows for any ridge taller than the rows above it.
    const heights = ridges.map((r) =>
      r.curve ? ridgeHeight(Math.max(...r.curve), maxM, MAX_RIDGE) : 0,
    );
    const top = Math.max(0, ...heights.map((h, i) => h + BASE_GAP + 2 - (i + 1) * ROW));
    return {
      top,
      list: ridges.map((r, i) => ({
        ridge: r,
        baseline: top + (i + 1) * ROW - BASE_GAP,
        ...ridgePaths(r.curve, plotW, maxM, MAX_RIDGE),
      })),
    };
  }, [ridges, plotW, maxM]);

  const height = rows.top + ridges.length * ROW;
  const rangeKey = ridges.length ? `${ridges[0].month}-${ridges[ridges.length - 1].month}` : "";

  const key = (month: number) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onPickMonth(month);
  };

  return (
    <div ref={boxRef}>
      {/* Keyed by range, so a new range remounts and opens on its newest month. */}
      <div
        key={rangeKey}
        ref={scrollToEnd}
        style={{ ...scroller, maxHeight: VIEW_ROWS * ROW + MAX_RIDGE }}
        onPointerLeave={() => setHover(null)}
      >
        <svg width="100%" height={height} style={{ display: "block" }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={ACCENT} stopOpacity={0.55} />
              <stop offset="1" stopColor={ACCENT} stopOpacity={0.04} />
            </linearGradient>
          </defs>
          {rows.list.map(({ ridge, baseline, line, area }, i) => {
            const on = hover === ridge.month || isolatedMonth === ridge.month;
            const yearLabel = i === 0 || ridge.month % 12 === 0;
            return (
              <g key={ridge.month} transform={`translate(${LABEL_W},${baseline})`}>
                <rect
                  role="button"
                  tabIndex={0}
                  aria-label={ridgeLabel(ridge)}
                  aria-pressed={isolatedMonth === ridge.month}
                  x={-LABEL_W}
                  y={BASE_GAP - ROW}
                  width={LABEL_W + plotW + GAIN_W}
                  height={ROW}
                  rx={6}
                  style={{ ...hit, fill: on ? "var(--accent-tint-weak)" : "transparent" }}
                  onClick={() => onPickMonth(ridge.month)}
                  onKeyDown={key(ridge.month)}
                  onPointerEnter={() => setHover(ridge.month)}
                  onFocus={() => setHover(ridge.month)}
                  onBlur={() => setHover(null)}
                >
                  <title>{tip(ridge)}</title>
                </rect>
                <line x1={0} x2={dayX(ridge.days, plotW)} y1={0} y2={0} style={baselineStyle} />
                {area && <path d={area} fill={`url(#${fillId})`} style={noHit} />}
                {line && <path d={line} style={{ ...ridgeLine, strokeWidth: on ? 2.2 : 1.4 }} />}
                {ridge.activeDays.map((d) => (
                  <circle key={d} cx={xOf(d)} cy={0} r={1.8} style={dayDot} />
                ))}
                <text x={-LABEL_W + 4} y={0} style={{ ...label, ...(on ? strong : null) }}>
                  {MONTHS[ridge.month % 12]}
                  {yearLabel && <tspan style={yearStyle}> {Math.floor(ridge.month / 12)}</tspan>}
                </text>
                <text
                  x={plotW + GAIN_W - 4}
                  y={0}
                  textAnchor="end"
                  style={{ ...label, ...(on ? strong : null) }}
                >
                  {ridge.count > 0 ? formatGain(ridge.gainM) : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <svg width="100%" height={AXIS_H} style={{ display: "block" }} aria-hidden="true">
        <g transform={`translate(${LABEL_W},0)`}>
          <line x1={0} x2={plotW} y1={0.5} y2={0.5} style={baselineStyle} />
          {DAY_TICKS.map((d) => (
            <text key={d} x={xOf(d)} y={14} textAnchor="middle" style={axisText}>
              {d}
            </text>
          ))}
          <text x={plotW + GAIN_W - 4} y={14} textAnchor="end" style={axisText}>
            day
          </text>
        </g>
      </svg>
      <p style={note}>
        {maxM > 0
          ? `Elevation gain per day (UTC); dots mark days with an activity. All months share one square-root height scale, so small days stay visible; the tallest peak is ${formatMeters(maxM)} m.`
          : "No activity in this range has a known elevation gain."}
      </p>
    </div>
  );
}

/** The native hover tooltip: the accessible name, plus how many days had an activity. */
function tip(ridge: MonthRidge): string {
  const base = ridgeLabel(ridge);
  if (ridge.count === 0) return base;
  const n = ridge.activeDays.length;
  return `${base}\n${n} active ${n === 1 ? "day" : "days"}`;
}

// Open on the newest month. Module-level so React calls it once per mount.
function scrollToEnd(el: HTMLDivElement | null) {
  if (el) el.scrollTop = el.scrollHeight;
}

const scroller: CSSProperties = {
  overflowY: "auto",
  overflowX: "hidden",
  scrollbarWidth: "thin",
  scrollbarColor: "var(--scrollbar) transparent",
};

const hit: CSSProperties = {
  cursor: "pointer",
  outline: "none",
  transition: "fill .12s",
};

const noHit: CSSProperties = { pointerEvents: "none" };

const baselineStyle: CSSProperties = {
  ...noHit,
  stroke: "var(--divider)",
  strokeWidth: 1,
};

const ridgeLine: CSSProperties = {
  ...noHit,
  fill: "none",
  stroke: ACCENT,
  strokeLinejoin: "round",
  strokeLinecap: "round",
};

const dayDot: CSSProperties = {
  ...noHit,
  fill: "var(--text-muted)",
};

const label: CSSProperties = {
  ...noHit,
  fontFamily: MONO,
  fontSize: 10.5,
  fill: "var(--text)",
};

const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  fill: "var(--text-muted)",
};

const strong: CSSProperties = { fill: "var(--text-strong)", fontWeight: 600 };

const yearStyle: CSSProperties = { fill: "var(--text-muted)", fontWeight: 400 };

const note: CSSProperties = {
  margin: "10px 0 0",
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-muted)",
};
