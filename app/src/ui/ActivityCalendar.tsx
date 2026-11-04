// Activity calendar: a GitHub-style grid of one year's days, each cell shaded by that
// day's moving time, with a button per year in the filter's range. The shades are the
// --heat-* tokens in index.css (one hue, stronger = more time); hovering a day shows
// its numbers and lists its activities by name and moving time.

import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { MONO, pillStyle } from "./theme";
import { formatDate, formatDuration } from "../format";
import type { CalendarDay, CalendarYear } from "../analytics";

const CELL = 11;
// A surface gap between cells, so neighbouring days never merge into one block.
const GAP = 2;
const PITCH = CELL + GAP;
const GUTTER = 28; // weekday labels
const TOP = 14; // month labels
const WEEKS = 53;
// The hover outline sits 1px outside its cell and is stroked across that line, so it
// reaches OUTLINE_GAP + OUTLINE_STROKE / 2 past the cell. The grid keeps that much room
// on its right and bottom, or the last column's and row's outlines are clipped.
const OUTLINE_GAP = 1;
const OUTLINE_STROKE = 1.5;
const EDGE = Math.ceil(OUTLINE_GAP + OUTLINE_STROKE / 2);

/** The grid's natural width: a full year at the designed cell size. */
export const CALENDAR_WIDTH = GUTTER + WEEKS * PITCH - GAP + EDGE;
// The grid scales down with its card, but no further than this; a narrower card (a
// phone) scrolls the year sideways instead of shrinking cells past legibility.
const MIN_WIDTH = Math.round(CALENDAR_WIDTH * 0.8);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Legend text per shade step (see calendarLevel). */
const LEVELS = ["None", "<1h", "1–2h", "2–4h", "4h+"];

// The tooltip's widest; long activity names are cut with an ellipsis to fit.
const TIP_WIDTH = 240;
// Half of it: how far the tooltip's anchor stays from the box edges.
const TIP_HALF = TIP_WIDTH / 2;

interface Hover {
  day: number;
  /** Tooltip anchor (top-center of the cell), relative to the calendar box. */
  x: number;
  y: number;
}

/**
 * The year to show, from `years` (newest first): the picked one while the filter's
 * range still covers it, else the newest.
 */
export function shownYear(years: CalendarYear[], picked: number | null): CalendarYear | undefined {
  return years.find((y) => y.year === picked) ?? years[0];
}

export function ActivityCalendar({ years }: { years: CalendarYear[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const shown = shownYear(years, picked);
  if (!shown) return null;

  // Every year at the same scale: 53 columns, or 54 for the rare year that needs it.
  const width = GUTTER + Math.max(WEEKS, shown.weeks) * PITCH - GAP + EDGE;
  const height = TOP + 7 * PITCH - GAP + EDGE;

  // Pointer over a gap keeps the last day, so the hit area is the whole pitch, not
  // just the painted cell. Down as well as move, so a tap works on touch screens.
  const track = (e: PointerEvent<SVGSVGElement>) => {
    const target = e.target as Element;
    const i = target.getAttribute("data-i");
    const box = boxRef.current?.getBoundingClientRect();
    if (i == null || !box) return;
    const cell = target.getBoundingClientRect();
    const x = cell.left + cell.width / 2 - box.left;
    setHover({
      day: Number(i),
      x: Math.min(Math.max(x, TIP_HALF), box.width - TIP_HALF),
      y: cell.top - box.top,
    });
  };

  const pick = (year: number) => {
    setPicked(year);
    setHover(null);
  };

  const hovered = hover && shown.days[hover.day];

  return (
    <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
      <div style={yearRow}>
        <div role="group" aria-label="Year" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {years.map((y) => (
            <button
              key={y.year}
              type="button"
              aria-pressed={y === shown}
              onClick={() => pick(y.year)}
              style={{ ...pillStyle(y === shown), fontFamily: MONO }}
            >
              {y.year}
            </button>
          ))}
        </div>
        <span style={muted}>
          {formatDuration(shown.movingSec)} · {activeDays(shown.activeDays)}
        </span>
      </div>

      {/* Keyed by year, so a newly picked year remounts and scrolls to its end. */}
      <div key={shown.year} ref={scrollToEnd} style={scroller}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label={`${shown.year}: ${formatDuration(shown.movingSec)} moving over ${activeDays(shown.activeDays)}`}
          onPointerMove={track}
          onPointerDown={track}
          style={{ display: "block", minWidth: MIN_WIDTH }}
        >
          {shown.months.map((m) => (
            <text key={m.month} x={GUTTER + m.week * PITCH} y={9} style={axisText}>
              {MONTHS[m.month]}
            </text>
          ))}
          {[0, 2, 4].map((row) => (
            <text key={row} x={0} y={TOP + row * PITCH + CELL - 2} style={axisText}>
              {WEEKDAYS[row]}
            </text>
          ))}
          {shown.days.map((d, i) => (
            <rect
              data-i={i}
              key={d.ts}
              x={GUTTER + d.week * PITCH}
              y={TOP + d.weekday * PITCH}
              width={CELL}
              height={CELL}
              rx={2}
              style={{ fill: `var(--heat-${d.level})` }}
            />
          ))}
          {hovered && (
            <rect
              x={GUTTER + hovered.week * PITCH - OUTLINE_GAP}
              y={TOP + hovered.weekday * PITCH - OUTLINE_GAP}
              width={CELL + 2 * OUTLINE_GAP}
              height={CELL + 2 * OUTLINE_GAP}
              rx={3}
              style={outline}
            />
          )}
        </svg>
      </div>

      <div style={legendRow}>
        {LEVELS.map((label, level) => (
          <span key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ ...swatch, background: `var(--heat-${level})` }} />
            {label}
          </span>
        ))}
      </div>

      {hover && hovered && (
        <div style={{ ...tooltip, left: hover.x, top: hover.y }}>
          <DayTip day={hovered} />
        </div>
      )}
    </div>
  );
}

/** Longest list the tooltip shows; the rest are counted in a "+N more" line. */
export const TIP_MAX_ACTIVITIES = 6;

/** A hovered day's tooltip: its total, date, and each activity's name and moving time. */
export function DayTip({ day }: { day: CalendarDay }) {
  const listed = day.activities.slice(0, TIP_MAX_ACTIVITIES);
  const more = day.activities.length - listed.length;
  return (
    <>
      <div style={tipValue}>{day.count > 0 ? formatDuration(day.movingSec) : "No activity"}</div>
      <div style={muted}>
        {day.count > 0 && `${day.count} ${day.count === 1 ? "activity" : "activities"} · `}
        {WEEKDAYS[day.weekday]}, {formatDate(day.ts)}
      </div>
      {listed.length > 0 && (
        <ul style={tipList}>
          {listed.map((a) => (
            <li key={a.id} style={tipItem}>
              <span style={tipName}>{a.name}</span>
              <span style={tipTime}>{formatDuration(a.movingSec)}</span>
            </li>
          ))}
          {more > 0 && <li style={muted}>+{more} more</li>}
        </ul>
      )}
    </>
  );
}

// When the year scrolls, start at its latest days. Module-level so React calls it once
// per mount rather than on every hover re-render.
function scrollToEnd(el: HTMLDivElement | null) {
  if (el) el.scrollLeft = el.scrollWidth;
}

function activeDays(n: number): string {
  return `${n} active ${n === 1 ? "day" : "days"}`;
}

const yearRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  marginBottom: 12,
};

const muted: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-muted)",
};

const scroller: CSSProperties = {
  overflowX: "auto",
  scrollbarWidth: "thin",
  scrollbarColor: "var(--scrollbar) transparent",
};

const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9,
  fill: "var(--text-muted)",
};

const outline: CSSProperties = {
  fill: "none",
  stroke: "var(--text-strong)",
  strokeWidth: OUTLINE_STROKE,
  pointerEvents: "none",
};

const legendRow: CSSProperties = {
  ...muted,
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: 12,
  marginTop: 12,
};

const swatch: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
};

const tooltip: CSSProperties = {
  position: "absolute",
  zIndex: 2,
  transform: "translate(-50%, calc(-100% - 6px))",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  maxWidth: TIP_WIDTH,
  padding: "6px 9px",
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.28)",
};

const tipValue: CSSProperties = {
  fontFamily: MONO,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-strong)",
  marginBottom: 2,
};

const tipList: CSSProperties = {
  listStyle: "none",
  margin: "6px 0 0",
  padding: "6px 0 0",
  borderTop: "1px solid var(--divider)",
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const tipItem: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 12,
  fontSize: 12,
  color: "var(--text)",
};

const tipName: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tipTime: CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-muted)",
};
