// Activity calendar: a GitHub-style grid of one year's days, each cell shaded by that
// day's moving time, with a button per year in the filter's range. The shades are the
// --heat-* tokens in index.css (one hue, stronger = more time); hovering a day shows
// its numbers and lists its activities by name and moving time.
//
// With step data, a second grid under it shades the same year's days by Garmin's daily
// step total: the same geometry, so the two line up week for week, under the same year
// buttons. Days under the 10k goal get an accent ring; days without a total get no cell.

import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO, pillStyle } from "./theme";
import { formatDate, formatDuration } from "../format";
import type { CalendarDay, CalendarYear } from "../analytics";
import { STEP_GOAL, STEPS_LEVELS, type StepsDay, type StepsYear } from "../steps";

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
// The under-goal ring is stroked inside its cell, so it never touches a neighbour.
const RING = 1.5;

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

/** Which grid a cell belongs to: moving time, or steps. */
type GridId = "time" | "steps";

/** One painted day of a grid. */
interface Cell {
  ts: number;
  week: number;
  weekday: number;
  /** --heat-* step. */
  level: number;
  /** Drawn with the under-goal ring. */
  ring?: boolean;
}

interface Hover {
  grid: GridId;
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

const timeCell = (d: CalendarDay): Cell => ({ ts: d.ts, week: d.week, weekday: d.weekday, level: d.level });
const stepsCell = (d: StepsDay): Cell => ({
  ts: d.ts,
  week: d.week,
  weekday: d.weekday,
  level: d.level,
  ring: d.level === 0,
});

export function ActivityCalendar({
  years,
  steps,
  compact = false,
}: {
  years: CalendarYear[];
  /** The step totals on the same years' grid; absent hides the steps grid (no step data). */
  steps?: StepsYear[];
  compact?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const shown = shownYear(years, picked);
  if (!shown) return null;
  const shownSteps = steps?.find((s) => s.year === shown.year);

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
      grid: target.getAttribute("data-g") === "steps" ? "steps" : "time",
      day: Number(i),
      x: Math.min(Math.max(x, TIP_HALF), box.width - TIP_HALF),
      y: cell.top - box.top,
    });
  };

  const pick = (year: number) => {
    setPicked(year);
    setHover(null);
  };

  const hoveredTime = hover?.grid === "time" ? shown.days[hover.day] : undefined;
  const hoveredSteps = hover?.grid === "steps" ? shownSteps?.days[hover.day] : undefined;
  const timeCells = shown.days.map(timeCell);
  const stepsCells = shownSteps?.days.map(stepsCell) ?? [];

  const grid = (id: GridId, cells: Cell[], label: string) =>
    compact ? (
      <MonthGrids
        year={shown.year}
        grid={id}
        cells={cells}
        hovered={hover?.grid === id ? hover.day : null}
        describe={id === "time" ? (n) => `${n} active days` : (n) => `${n} days with steps`}
        countOf={id === "time" ? (i) => (shown.days[i].count > 0 ? 1 : 0) : () => 1}
        onTrack={track}
      />
    ) : (
      <YearGrid
        year={shown.year}
        weeks={shown.weeks}
        months={shown.months}
        grid={id}
        cells={cells}
        hovered={hover?.grid === id ? hover.day : null}
        label={label}
        onTrack={track}
      />
    );

  const timeSummary = `${formatDuration(shown.movingSec)} · ${activeDays(shown.activeDays)}`;

  return (
    <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
      <div style={yearRow}>
        <div role="group" aria-label="Year" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {years.map((y) => (
            <button
              key={y.year}
              type="button"
              className={y === shown ? undefined : "ctl"}
              aria-pressed={y === shown}
              onClick={() => pick(y.year)}
              style={{ ...pillStyle(y === shown), fontFamily: MONO }}
            >
              {y.year}
            </button>
          ))}
        </div>
        {/* With a steps grid each grid's summary sits on its own label row; alone, the
            moving-time grid needs no label, so its summary stays by the years. */}
        {!steps && <span style={muted}>{timeSummary}</span>}
      </div>

      {steps && (
        <div style={{ ...yearRow, margin: "0 0 8px" }}>
          <span style={{ ...gridLabel, margin: 0 }}>Moving time</span>
          <span style={muted}>{timeSummary}</span>
        </div>
      )}
      {grid(
        "time",
        timeCells,
        `${shown.year}: ${formatDuration(shown.movingSec)} moving over ${activeDays(shown.activeDays)}`,
      )}
      <Legend labels={LEVELS} />

      {steps && (
        <>
          <div style={{ ...yearRow, margin: "18px 0 8px" }}>
            <span style={{ ...gridLabel, margin: 0 }}>Steps</span>
            {shownSteps && shownSteps.average != null && (
              <span style={muted}>{stepsSummary(shownSteps)}</span>
            )}
          </div>
          {shownSteps && shownSteps.days.length > 0 ? (
            <>
              {grid("steps", stepsCells, `${shown.year} steps: ${stepsSummary(shownSteps)}`)}
              <Legend labels={STEPS_LEVELS} ringFirst />
            </>
          ) : (
            <p style={{ ...muted, margin: 0 }}>No step data for {shown.year}.</p>
          )}
        </>
      )}

      {hover && (hoveredTime || hoveredSteps) && (
        <div style={{ ...tooltip, left: hover.x, top: hover.y }}>
          {hoveredTime ? <DayTip day={hoveredTime} /> : hoveredSteps && <StepsTip day={hoveredSteps} />}
        </div>
      )}
    </div>
  );
}

/** "average 14.8k a day · 308 of 310 days at 10k or more" */
export function stepsSummary(y: StepsYear): string {
  const avg = y.average == null ? "—" : `${(y.average / 1000).toFixed(1)}k`;
  return `average ${avg} a day · ${y.atGoal} of ${y.days.length} days at ${STEP_GOAL / 1000}k or more`;
}

/** A shade's cell style: its --heat-* fill, plus the accent ring for a day under the goal. */
function cellStyle(c: Cell): CSSProperties {
  return c.ring
    ? { fill: `var(--heat-${c.level})`, stroke: "var(--accent)", strokeWidth: RING }
    : { fill: `var(--heat-${c.level})` };
}

/** A cell's rect geometry at (x, y): ringed cells shrink by half the stroke, so it stays inside. */
function cellRect(c: Cell, x: number, y: number, size: number) {
  const inset = c.ring ? RING / 2 : 0;
  return { x: x + inset, y: y + inset, width: size - 2 * inset, height: size - 2 * inset };
}

function Legend({ labels, ringFirst = false }: { labels: string[]; ringFirst?: boolean }) {
  return (
    <div style={legendRow}>
      {labels.map((label, level) => (
        <span key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              ...swatch,
              background: `var(--heat-${level})`,
              ...(ringFirst && level === 0 ? { boxShadow: `inset 0 0 0 ${RING}px var(--accent)` } : null),
            }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

/** A whole year as one row of week columns (the wide layout). */
function YearGrid({
  year,
  weeks,
  months,
  grid,
  cells,
  hovered,
  label,
  onTrack,
}: {
  year: number;
  weeks: number;
  months: CalendarYear["months"];
  grid: GridId;
  cells: Cell[];
  hovered: number | null;
  label: string;
  onTrack: (e: PointerEvent<SVGSVGElement>) => void;
}) {
  // Every year at the same scale: 53 columns, or 54 for the rare year that needs it.
  const width = GUTTER + Math.max(WEEKS, weeks) * PITCH - GAP + EDGE;
  const height = TOP + 7 * PITCH - GAP + EDGE;
  const outside = outsideCells(year, cells);
  const h = hovered == null ? undefined : cells[hovered];
  return (
    /* Keyed by year, so a newly picked year remounts and scrolls to its latest day. */
    <div key={year} ref={scrollToLatest(`${grid}:${year}:${cells.length}:${width}`, cells.at(-1)?.week ?? 0, width)} style={scroller}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={label}
        onPointerMove={onTrack}
        onPointerDown={onTrack}
        style={{ display: "block", minWidth: MIN_WIDTH }}
      >
        {months.map((m) => (
          <text key={m.month} x={GUTTER + m.week * PITCH} y={9} style={axisText}>
            {MONTHS[m.month]}
          </text>
        ))}
        {[0, 2, 4].map((row) => (
          <text key={row} x={0} y={TOP + row * PITCH + CELL - 2} style={axisText}>
            {WEEKDAYS[row]}
          </text>
        ))}
        {/* The rest of the year, outside the date range, still to come, or without a
            value: faint outlines, so every year reads as a whole year at the same scale. */}
        {outside.map(([week, weekday]) => (
          <rect
            key={`o${week}-${weekday}`}
            x={GUTTER + week * PITCH + 0.5}
            y={TOP + weekday * PITCH + 0.5}
            width={CELL - 1}
            height={CELL - 1}
            rx={2}
            style={outsideCell}
          />
        ))}
        {cells.map((c, i) => (
          <rect
            data-i={i}
            data-g={grid}
            key={c.ts}
            {...cellRect(c, GUTTER + c.week * PITCH, TOP + c.weekday * PITCH, CELL)}
            rx={2}
            style={cellStyle(c)}
          />
        ))}
        {h && (
          <rect
            x={GUTTER + h.week * PITCH - OUTLINE_GAP}
            y={TOP + h.weekday * PITCH - OUTLINE_GAP}
            width={CELL + 2 * OUTLINE_GAP}
            height={CELL + 2 * OUTLINE_GAP}
            rx={3}
            style={outline}
          />
        )}
      </svg>
    </div>
  );
}

/**
 * The phone's calendar: the year wrapped into twelve small month grids (Monday-first
 * weeks as rows), three to a row, so every day stays a legible tap target with no
 * sideways scrolling.
 */
function MonthGrids({
  year,
  grid,
  cells,
  hovered,
  describe,
  countOf,
  onTrack,
}: {
  year: number;
  grid: GridId;
  cells: Cell[];
  hovered: number | null;
  /** A month's aria label count ("12 active days"). */
  describe: (n: number) => string;
  /** What a cell adds to that count. */
  countOf: (i: number) => number;
  onTrack: (e: PointerEvent<SVGSVGElement>) => void;
}) {
  const P = 13; // cell pitch in viewBox units
  const C = 11;
  const byMonth: { c: Cell; i: number }[][] = Array.from({ length: 12 }, () => []);
  cells.forEach((c, i) => byMonth[new Date(c.ts * 1000).getUTCMonth()].push({ c, i }));
  const h = hovered == null ? undefined : cells[hovered];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "12px 14px" }}>
      {byMonth.map((list, m) => {
        const first = Date.UTC(year, m, 1);
        const offset = (new Date(first).getUTCDay() + 6) % 7;
        const days = (Date.UTC(year, m + 1, 1) - first) / 86_400_000;
        const pos = (dom: number) => ({ x: ((dom - 1 + offset) % 7) * P, y: Math.floor((dom - 1 + offset) / 7) * P });
        const taken = new Set(list.map(({ c }) => new Date(c.ts * 1000).getUTCDate()));
        const n = list.reduce((s, { i }) => s + countOf(i), 0);
        return (
          <div key={m}>
            <div style={{ ...muted, marginBottom: 4, fontWeight: 600, color: "var(--text-soft)" }}>{MONTHS[m]}</div>
            <svg
              viewBox={`-1 -1 ${7 * P + 1} ${6 * P + 1}`}
              width="100%"
              role="img"
              aria-label={`${MONTHS[m]} ${year}: ${describe(n)}`}
              onPointerMove={onTrack}
              onPointerDown={onTrack}
              style={{ display: "block" }}
            >
              {Array.from({ length: days }, (_, k) => k + 1)
                .filter((dom) => !taken.has(dom))
                .map((dom) => {
                  const { x, y } = pos(dom);
                  return <rect key={`o${dom}`} x={x + 0.5} y={y + 0.5} width={C - 1} height={C - 1} rx={2} style={outsideCell} />;
                })}
              {list.map(({ c, i }) => {
                const { x, y } = pos(new Date(c.ts * 1000).getUTCDate());
                return <rect key={c.ts} data-i={i} data-g={grid} {...cellRect(c, x, y, C)} rx={2} style={cellStyle(c)} />;
              })}
              {h && list.some(({ c }) => c === h) && (() => {
                const { x, y } = pos(new Date(h.ts * 1000).getUTCDate());
                return <rect x={x - 1} y={y - 1} width={C + 2} height={C + 2} rx={3} style={outline} />;
              })()}
            </svg>
          </div>
        );
      })}
    </div>
  );
}

/** A hovered day's steps: the total and the date. */
export function StepsTip({ day }: { day: StepsDay }) {
  return (
    <>
      <div style={tipValue}>{day.steps.toLocaleString("en-US")} steps</div>
      <div style={muted}>
        {WEEKDAYS[day.weekday]}, {formatDate(day.ts)}
      </div>
    </>
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

/** [week, weekday] of every day of `year` that has no cell (outside the range, or no value). */
function outsideCells(year: number, cells: Cell[]): [number, number][] {
  const jan1 = Date.UTC(year, 0, 1);
  const offset = (new Date(jan1).getUTCDay() + 6) % 7; // Monday first
  const days = (Date.UTC(year + 1, 0, 1) - jan1) / 86_400_000;
  const taken = new Set(cells.map((d) => d.week * 7 + d.weekday));
  const out: [number, number][] = [];
  for (let n = 0; n < days; n++) {
    const week = Math.floor((n + offset) / 7);
    const weekday = (n + offset) % 7;
    if (!taken.has(week * 7 + weekday)) out.push([week, weekday]);
  }
  return out;
}

// When the year scrolls (a phone), open on its latest recorded day rather than on the
// empty weeks still to come. Cached per grid and year, so React calls it once per mount
// rather than on every hover re-render.
const scrollers = new Map<string, (el: HTMLDivElement | null) => void>();
function scrollToLatest(key: string, lastWeek: number, width: number) {
  let fn = scrollers.get(key);
  if (!fn) {
    const frac = Math.min(1, (GUTTER + (lastWeek + 2) * PITCH) / width);
    fn = (el) => {
      if (el) el.scrollLeft = frac * el.scrollWidth - el.clientWidth;
    };
    scrollers.set(key, fn);
  }
  return fn;
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
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
};

const scroller: CSSProperties = {
  overflowX: "auto",
  scrollbarWidth: "thin",
  scrollbarColor: "var(--scrollbar) transparent",
};

const axisText: CSSProperties = {
  fontSize: 8.5,
  fill: "var(--text-muted)",
};

const outsideCell: CSSProperties = {
  fill: "none",
  stroke: "var(--card-grid)",
  strokeWidth: 1,
  pointerEvents: "none",
};

const outline: CSSProperties = {
  fill: "none",
  stroke: "var(--text-strong)",
  strokeWidth: OUTLINE_STROKE,
  pointerEvents: "none",
};

const gridLabel: CSSProperties = {
  fontSize: FS.xs + 1,
  fontWeight: 600,
  color: "var(--text-soft)",
  marginBottom: 6,
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
