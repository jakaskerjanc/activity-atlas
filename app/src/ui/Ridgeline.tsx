// The ridgeline (#20): one filled silhouette per month of the date range, oldest at the
// top, each the month's median route profile; taller ridges overlap the row above, so
// the shape of a period reads at a glance. Every row also shows the month's elevation
// gain. Clicking a row isolates that month through the Activity filter (App owns the
// filter); clicking it again restores the range from before. Plain SVG, like the
// activity charts. Geometry and numbers live in ridgeline.ts.

import { useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ACCENT, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { formatGain, ridgeHeight, ridgeLabel, ridgePaths, type MonthRidge } from "../ridgeline";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Props {
  /** One ridge per month of the date range, oldest first (monthRidges). */
  ridges: MonthRidge[];
  /** The month isolated by a click, while the range is still just that month. */
  isolatedMonth: number | null;
  onPickMonth: (month: number) => void;
}

export function Ridgeline({ ridges, isolatedMonth, onPickMonth }: Props) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [hover, setHover] = useState<number | null>(null);
  // useId's characters aren't all safe inside url(#…).
  const fillId = `ridge-fill-${useId().replace(/[^\w-]/g, "")}`;

  const plotW = Math.max(ROW, width - SCROLL_GUTTER - LABEL_W - GAIN_W);
  const maxRelief = Math.max(0, ...ridges.map((r) => r.relief));

  const rows = useMemo(() => {
    // Room above the first rows for any ridge taller than the rows above it.
    const top = Math.max(
      0,
      ...ridges.map(
        (r, i) => ridgeHeight(r.relief, maxRelief, MAX_RIDGE) + BASE_GAP + 2 - (i + 1) * ROW,
      ),
    );
    return {
      top,
      list: ridges.map((r, i) => ({
        ridge: r,
        baseline: top + (i + 1) * ROW - BASE_GAP,
        ...ridgePaths(r.signature, plotW, maxRelief, MAX_RIDGE),
      })),
    };
  }, [ridges, plotW, maxRelief]);

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
                <line x1={0} x2={plotW} y1={0} y2={0} style={baselineStyle} />
                {area && <path d={area} fill={`url(#${fillId})`} style={noHit} />}
                {line && (
                  <path d={line} style={{ ...ridgeLine, strokeWidth: on ? 2.2 : 1.4 }} />
                )}
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
      <p style={note}>
        {maxRelief > 0
          ? `Tallest ridge ${formatMeters(maxRelief)} m above its month's lowest point · square-root height scale.`
          : "No elevation profiles in this range."}
      </p>
    </div>
  );
}

/** The native hover tooltip: the accessible name, plus how many activities shape the ridge. */
function tip(ridge: MonthRidge): string {
  const base = ridgeLabel(ridge);
  if (ridge.count === 0) return base;
  return `${base}\n${ridge.profiled} of ${ridge.count} with an elevation profile`;
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

const label: CSSProperties = {
  ...noHit,
  fontFamily: MONO,
  fontSize: 10.5,
  fill: "var(--text)",
};

const strong: CSSProperties = { fill: "var(--text-strong)", fontWeight: 600 };

const yearStyle: CSSProperties = { fill: "var(--text-muted)", fontWeight: 400 };

const note: CSSProperties = {
  margin: "10px 0 0",
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-muted)",
};
