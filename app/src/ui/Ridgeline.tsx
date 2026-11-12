// The climbing ridgeline (#20): one ridge per month of the date range, oldest at the
// top. Along each ridge x is the day of the month and the height is that day's
// elevation gain; the tallest ridges overlap about half the row above, like a joyplot.
// Dots on the baseline mark days with an activity, every row shows the month's total
// gain, and hovering (or tapping) a day names its activities and their climbing.
// Clicking a row isolates that month through the Activity filter (App owns the filter);
// clicking it again restores the range from before. Plain SVG, like the activity
// charts. Numbers live in ridgeline.ts.

import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ACCENT, FS, MONO } from "./theme";
import { typeColor } from "../colors";
import { formatDate, monthStart } from "../format";
import type { Theme } from "../types";
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
/**
 * Height of the tallest ridge in view: 1.6 rows, so even the biggest day only reaches
 * into the lower half of the row above and never across a neighbour's label.
 */
export const MAX_RIDGE = ROW * 1.6;
/** Gap between a row's baseline and the bottom of its band, room for label descenders. */
const BASE_GAP = 8;
/** Rows shown before the chart scrolls (two years). */
const VIEW_ROWS = 24;
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
  /** A phone: narrower label columns, so the ridges keep most of the width. */
  compact?: boolean;
  theme?: Theme;
}

interface DayHover {
  month: number;
  day: number;
  /** Tooltip anchor relative to the chart box: the day's x, the row band's top. */
  x: number;
  y: number;
}

export function Ridgeline({ ridgeline, isolatedMonth, onPickMonth, compact = false, theme = "dark" }: Props) {
  const LABEL_W = compact ? 58 : 76;
  const GAIN_W = compact ? 58 : 60;
  const { ridges, maxM } = ridgeline;
  const [boxRef, width] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [hover, setHover] = useState<number | null>(null);
  const [dayHover, setDayHover] = useState<DayHover | null>(null);
  const outerRef = useRef<HTMLDivElement>(null);
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
  // Taller than the view: the top fades out, so a ridge cut by the scroll edge reads as
  // "more above", not as a clipped peak.
  const scrolls = height > VIEW_ROWS * ROW + MAX_RIDGE;
  const rangeKey = ridges.length ? `${ridges[0].month}-${ridges[ridges.length - 1].month}` : "";
  // A new range lays the rows out afresh: drop a day hover anchored to the old layout.
  const [hoverKey, setHoverKey] = useState(rangeKey);
  if (hoverKey !== rangeKey) {
    setHoverKey(rangeKey);
    setDayHover(null);
  }

  // Which day the pointer is over, from its x inside the row's band.
  const trackDay = (ridge: MonthRidge) => (e: PointerEvent<SVGRectElement>) => {
    const band = e.currentTarget.getBoundingClientRect();
    const box = outerRef.current?.getBoundingClientRect();
    const local = e.clientX - band.left - LABEL_W;
    const day = Math.floor((local / plotW) * 31) + 1;
    if (!box || local < 0 || day < 1 || day > ridge.days) return setDayHover(null);
    setDayHover({
      month: ridge.month,
      day,
      x: band.left - box.left + LABEL_W + xOf(day),
      y: band.top - box.top,
    });
  };

  const key = (month: number) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onPickMonth(month);
  };

  return (
    <div ref={outerRef} style={{ position: "relative" }}>
    <div ref={boxRef}>
      {/* Keyed by range, so a new range remounts and opens on its newest month. */}
      <div
        key={rangeKey}
        ref={scrollToEnd}
        style={{
          ...scroller,
          maxHeight: VIEW_ROWS * ROW + MAX_RIDGE,
          ...(scrolls ? { maskImage: FADE_TOP, WebkitMaskImage: FADE_TOP } : null),
        }}
        onPointerLeave={() => {
          setHover(null);
          setDayHover(null);
        }}
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
                  className="svg-focus"
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
                  onPointerMove={trackDay(ridge)}
                  onPointerDown={trackDay(ridge)}
                  onFocus={() => setHover(ridge.month)}
                  onBlur={() => setHover(null)}
                />
                <line x1={0} x2={dayX(ridge.days, plotW)} y1={0} y2={0} style={baselineStyle} />
                {area && <path d={area} fill={`url(#${fillId})`} style={noHit} />}
                {line && <path d={line} style={{ ...ridgeLine, strokeWidth: on ? 2.2 : 1.4 }} />}
                {ridge.activeDays.map((d) => (
                  <circle key={d} cx={xOf(d)} cy={0} r={1.8} style={dayDot} />
                ))}
                {dayHover?.month === ridge.month && (
                  <g style={noHit}>
                    <line
                      x1={xOf(dayHover.day)}
                      x2={xOf(dayHover.day)}
                      y1={BASE_GAP - ROW}
                      y2={0}
                      stroke="var(--text-soft)"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                    <circle
                      cx={xOf(dayHover.day)}
                      cy={-ridgeHeight(ridge.daily[dayHover.day - 1] ?? 0, maxM, MAX_RIDGE)}
                      r={3.5}
                      fill={ACCENT}
                      stroke="var(--bg-raised)"
                      strokeWidth={1.5}
                    />
                  </g>
                )}
                <text x={-LABEL_W + 4} y={0} style={{ ...label, fontFamily: "var(--font-ui)", ...(on ? strong : null) }}>
                  {MONTHS[ridge.month % 12]}
                  {yearLabel && (
                    <tspan style={yearStyle}>
                      {" "}
                      {compact ? `’${String(Math.floor(ridge.month / 12)).slice(2)}` : Math.floor(ridge.month / 12)}
                    </tspan>
                  )}
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
          ? `Dots mark active days. One shared square-root scale; the tallest day is ${formatMeters(maxM)} m.`
          : "No activity in this range has a known elevation gain."}
      </p>
    </div>
      {dayHover && (
        <DayTooltip
          hover={dayHover}
          ridge={ridges.find((r) => r.month === dayHover.month)}
          theme={theme}
          width={width}
        />
      )}
    </div>
  );
}

const TIP_W = 240;

/** The hovered day: its date, its climbing, and each activity with its own gain. */
function DayTooltip({ hover, ridge, theme, width }: { hover: DayHover; ridge?: MonthRidge; theme: Theme; width: number }) {
  if (!ridge) return null;
  const list = ridge.byDay?.[hover.day - 1] ?? [];
  const gain = ridge.daily[hover.day - 1] ?? 0;
  const ts = monthStart(ridge.month) + (hover.day - 1) * 86400;
  const weekday = new Date(ts * 1000).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const left = Math.min(Math.max(hover.x, TIP_W / 2), width - TIP_W / 2);
  return (
    <div role="tooltip" style={{ ...tipBox, left, top: hover.y }}>
      <div style={tipHead}>
        {list.length === 0 ? "No activity" : gain > 0 ? `${formatMeters(gain)} m climbed` : "No climbing recorded"}
      </div>
      <div style={tipSub}>
        {weekday}, {formatDate(ts)}
      </div>
      {list.length > 0 && (
        <ul style={tipList}>
          {list.slice(0, 5).map((a) => (
            <li key={a.id} style={tipItem}>
              <span style={{ ...tipDot, background: typeColor(a.type, theme) }} />
              <span style={tipName}>{a.name}</span>
              <span style={tipVal}>{a.gainM != null ? `${formatMeters(a.gainM)} m` : "–"}</span>
            </li>
          ))}
          {list.length > 5 && <li style={tipSub}>+{list.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}

const tipBox: CSSProperties = {
  position: "absolute",
  zIndex: 3,
  width: "max-content",
  maxWidth: TIP_W,
  transform: "translate(-50%, calc(-100% - 6px))",
  pointerEvents: "none",
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--panel-solid)",
  border: "1px solid var(--panel-border)",
  boxShadow: "var(--panel-shadow)",
};
const tipHead: CSSProperties = { fontSize: FS.sm + 0.5, fontWeight: 650, color: "var(--text-strong)", fontVariantNumeric: "tabular-nums" };
const tipSub: CSSProperties = { marginTop: 2, fontSize: FS.xs + 0.5, color: "var(--text-muted)" };
const tipList: CSSProperties = {
  listStyle: "none",
  margin: "6px 0 0",
  padding: "6px 0 0",
  borderTop: "1px solid var(--divider)",
  display: "grid",
  gap: 3,
};
const tipItem: CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: FS.xs + 1, color: "var(--text)" };
const tipDot: CSSProperties = { width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto" };
const tipName: CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tipVal: CSSProperties = { color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" };

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
  transition: "fill .12s",
};

const FADE_TOP = "linear-gradient(to bottom, transparent 0, #000 40px)";

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
  fontSize: FS.xs,
  fill: "var(--text)",
};

const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS["2xs"],
  fill: "var(--text-muted)",
};

const strong: CSSProperties = { fill: "var(--text-strong)", fontWeight: 600 };

const yearStyle: CSSProperties = { fill: "var(--text-muted)", fontWeight: 400 };

const note: CSSProperties = {
  margin: "10px 0 0",
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
};
