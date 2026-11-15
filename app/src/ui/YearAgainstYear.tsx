// Year against year: the visible activities' running total through the calendar year,
// one line per year on a shared January-to-December axis. The newest year is the accent
// line; earlier years are grey, fading with age, and each is named at its end and in the
// legend (which also gives its total). A sentence above reads the newest year against the
// one before on the same date; hovering reads every year on the day under the pointer.

import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO, pillStyle } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { niceTicks } from "../profile";
import {
  formatMeasure,
  formatRefDay,
  MEASURE_AXIS,
  REF_DAYS,
  refDayOf,
  valueOn,
  yearComparison,
  yearLines,
  type YearLine,
  type YearMeasure,
} from "../yearLines";
import type { ActivityRecord } from "../types";

const MEASURES: { value: YearMeasure; label: string; noun: string; missing: string }[] = [
  { value: "distance", label: "Distance", noun: "distance", missing: "a distance" },
  { value: "climbing", label: "Climbing", noun: "elevation gain", missing: "an elevation gain" },
  { value: "time", label: "Time", noun: "moving time", missing: "a moving time" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const Y_AXIS_W = 52;
/** Room right of the plot for the year names at the lines' ends. */
const LABEL_W = 38;
const X_AXIS_H = 20;
const TOP = 10;
/** Closest two year names may sit, baseline to baseline. */
const LABEL_GAP = 12;

/** How strongly a year is drawn, by how many years before the newest it is. */
function ageOpacity(age: number): number {
  return age === 0 ? 1 : age === 1 ? 0.85 : age === 2 ? 0.55 : 0.36;
}

export function YearAgainstYear({
  activities,
  from,
  end,
  compact = false,
}: {
  /** The visible activities. */
  activities: readonly ActivityRecord[];
  /** The date range in epoch seconds, `end` no later than now. */
  from: number;
  end: number;
  compact?: boolean;
}) {
  const [measure, setMeasure] = useState<YearMeasure>("distance");
  const [picked, setPicked] = useState<number | null>(null);
  const lines = useMemo(() => yearLines(activities, from, end, measure), [activities, from, end, measure]);
  const meta = MEASURES.find((m) => m.value === measure)!;
  const latest = lines[lines.length - 1];
  const comparison = yearComparison(lines);

  return (
    <>
      <div style={header}>
        <p style={lead}>
          {latest && (
            <>
              <strong style={leadValue}>{formatMeasure(latest.total, measure)}</strong>
              {[
                ` in ${latest.year}`,
                latest.toDay < REF_DAYS - 1 ? ` by ${formatRefDay(latest.toDay)}` : "",
                comparison
                  ? `, ${standing(comparison.value - comparison.againstValue, measure)} ${comparison.against}`
                  : "",
              ].join("")}
            </>
          )}
        </p>
        <div role="group" aria-label="Measure" style={{ display: "flex", gap: 6 }}>
          {MEASURES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={measure === m.value ? undefined : "ctl"}
              aria-pressed={measure === m.value}
              onClick={() => setMeasure(m.value)}
              style={pillStyle(measure === m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {lines.length === 0 ? (
        <p style={status}>No visible activity has {meta.missing}.</p>
      ) : (
        <>
          <Chart lines={lines} measure={measure} noun={meta.noun} picked={picked} compact={compact} />
          {lines.length > 1 && (
            <ul style={legend} onPointerLeave={() => setPicked(null)}>
              {[...lines].reverse().map((l, age) => (
                <li
                  key={l.year}
                  style={{ ...legendItem, background: picked === l.year ? "var(--control-hover)" : undefined }}
                  onPointerEnter={() => setPicked(l.year)}
                >
                  <span style={{ ...swatch(age), opacity: ageOpacity(age) }} aria-hidden />
                  <span style={legendYear}>{l.year}</span>
                  <span style={legendValue}>{formatMeasure(l.total, measure)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

/** "240 km ahead of", "12 km behind", "level with": the newest year against the one before. */
function standing(diff: number, measure: YearMeasure): string {
  const text = formatMeasure(Math.abs(diff), measure);
  if (/^0 /.test(text)) return "level with";
  return `${text} ${diff > 0 ? "ahead of" : "behind"}`;
}

function Chart({
  lines,
  measure,
  noun,
  picked,
  compact,
}: {
  lines: YearLine[];
  measure: YearMeasure;
  noun: string;
  /** The year hovered in the legend. */
  picked: number | null;
  compact: boolean;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(60, width - Y_AXIS_W - LABEL_W);
  const plotH = compact ? 170 : 230;
  const { per, unit } = MEASURE_AXIS[measure];
  const max = Math.max(...lines.map((l) => l.total)) / per;
  const ticks = max > 0 ? niceTicks(0, max, compact ? 3 : 4) : [0];
  const top = Math.max(max, ticks[ticks.length - 1]) || 1;
  // x takes a position in days from 1 Jan 00:00; a day's total sits at the day's end.
  const xOf = (pos: number) => (pos / REF_DAYS) * plotW;
  const yOf = (value: number) => TOP + plotH - (value / per / top) * plotH;
  const newest = lines[lines.length - 1].year;
  const monthW = plotW / 12;

  const paths = useMemo(
    () =>
      lines.map((l) => {
        let d = `M${xOf(l.fromDay).toFixed(1)},${yOf(0).toFixed(1)}`;
        let last = 0;
        l.cumulative.forEach((v, i) => {
          // Flat stretches need only their two ends.
          if (v === last && i < l.cumulative.length - 1 && l.cumulative[i + 1] === v) return;
          d += `L${xOf(l.fromDay + i + 1).toFixed(1)},${yOf(v).toFixed(1)}`;
          last = v;
        });
        return d;
      }),
    // xOf and yOf depend on exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, plotW, plotH, top, per],
  );

  // Year names at the lines' ends. Those ending at the right edge are spread apart from
  // the top down, so two years with close totals stay readable.
  const labels = lines
    .map((l) => ({ year: l.year, x: xOf(l.toDay + 1) + 6, y: yOf(l.total) + 3.5, edge: l.toDay === REF_DAYS - 1 }))
    .sort((a, b) => a.y - b.y);
  let floor = -Infinity;
  for (const label of labels) {
    if (!label.edge) continue;
    label.y = Math.max(label.y, floor + LABEL_GAP);
    floor = label.y;
  }

  const track = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const day = Math.floor(((e.clientX - box.left - Y_AXIS_W) / plotW) * REF_DAYS);
    setHover(day < 0 || day >= REF_DAYS ? null : day);
  };

  const readings =
    hover == null
      ? []
      : [...lines].reverse().flatMap((l, age) => {
          const value = valueOn(l, hover);
          return value == null ? [] : [{ year: l.year, age, value }];
        });
  const cursorX = hover == null ? 0 : Y_AXIS_W + xOf(hover + 1);
  const tipLeft = cursorX > Y_AXIS_W + plotW / 2;

  return (
    <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
      <svg
        width={width}
        height={TOP + plotH + X_AXIS_H}
        role="img"
        aria-label={`Running ${noun} through the year: ${lines
          .map((l) => `${l.year} ${formatMeasure(l.total, measure)}`)
          .join(", ")}`}
        onPointerMove={track}
        onPointerDown={track}
        style={{ display: "block", overflow: "visible", touchAction: "pan-y" }}
      >
        <g transform={`translate(${Y_AXIS_W},0)`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={yOf(t * per)} y2={yOf(t * per)} style={gridLine} />
              <text x={-8} y={yOf(t * per) + 3.5} textAnchor="end" style={axisText}>
                {t.toLocaleString("en-US")}
                {unit}
              </text>
            </g>
          ))}
          {MONTHS.map((name, m) => (
            <text key={name} x={xOf(refDayOf(m, 1)) + monthW / 2} y={TOP + plotH + 14} textAnchor="middle" style={axisText}>
              {monthW >= 30 ? name : name[0]}
            </text>
          ))}
          {lines.map((l, i) => {
            const age = newest - l.year;
            const on = picked === l.year;
            const dim = picked != null && !on;
            return (
              <path
                key={l.year}
                d={paths[i]}
                fill="none"
                stroke={age === 0 ? "var(--accent)" : "var(--text-muted)"}
                strokeWidth={age === 0 || on ? 2.5 : 1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={dim ? 0.2 : on ? 1 : ageOpacity(age)}
                style={{ transition: "opacity 120ms" }}
              />
            );
          })}
          {labels.map((label) => (
            <text
              key={label.year}
              x={label.x}
              y={label.y}
              style={{
                ...axisText,
                fill: label.year === newest || picked === label.year ? "var(--text-strong)" : "var(--text-muted)",
                fontWeight: label.year === newest ? 600 : 400,
              }}
            >
              {label.year}
            </text>
          ))}
          {hover != null && readings.length > 0 && (
            <>
              <line x1={xOf(hover + 1)} x2={xOf(hover + 1)} y1={TOP} y2={TOP + plotH} style={cursorLine} />
              {readings.map((r) => (
                <circle
                  key={r.year}
                  cx={xOf(hover + 1)}
                  cy={yOf(r.value)}
                  r={r.age === 0 ? 4 : 3}
                  fill={r.age === 0 ? "var(--accent)" : "var(--text-muted)"}
                  stroke="var(--bg-raised)"
                  strokeWidth={2}
                />
              ))}
            </>
          )}
        </g>
      </svg>
      {hover != null && readings.length > 0 && (
        <div
          style={{
            ...tooltip,
            top: TOP + 4,
            left: cursorX,
            transform: tipLeft ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
          }}
        >
          <div style={tipTitle}>By {formatRefDay(hover)}</div>
          <table style={tipTable}>
            <tbody>
              {readings.map((r) => (
                <tr key={r.year}>
                  <td>
                    <span style={{ ...swatch(r.age), opacity: ageOpacity(r.age) }} aria-hidden />
                  </td>
                  <td style={tipCell}>{r.year}</td>
                  <td style={{ ...tipCell, ...tipNum }}>{formatMeasure(r.value, measure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "8px 12px",
  margin: "0 0 12px",
};

const lead: CSSProperties = { margin: 0, fontSize: FS.sm, color: "var(--text-muted)", lineHeight: 1.4 };
const leadValue: CSSProperties = { fontFamily: MONO, fontSize: FS.md, fontWeight: 600, color: "var(--text-strong)" };
const status: CSSProperties = { margin: 0, fontSize: FS.sm, color: "var(--text-muted)" };

const legend: CSSProperties = {
  listStyle: "none",
  margin: "10px -8px 0",
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "2px 6px",
};
const legendItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 8px",
  borderRadius: 8,
  transition: "background 120ms",
};
const legendYear: CSSProperties = { fontFamily: MONO, fontSize: FS.sm, color: "var(--text)" };
const legendValue: CSSProperties = { fontFamily: MONO, fontSize: FS.sm, color: "var(--text-muted)" };

/** A short stroke in the line's color: the accent for the newest year, grey before. */
function swatch(age: number): CSSProperties {
  return {
    display: "inline-block",
    flex: "none",
    width: 14,
    height: age === 0 ? 3 : 2,
    borderRadius: 2,
    verticalAlign: "middle",
    background: age === 0 ? "var(--accent)" : "var(--text-muted)",
  };
}

const gridLine: CSSProperties = { stroke: "var(--card-grid)", strokeWidth: 1 };
const cursorLine: CSSProperties = { stroke: "var(--text-faint)", strokeWidth: 1, pointerEvents: "none" };
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
const tipTable: CSSProperties = { borderCollapse: "collapse" };
const tipCell: CSSProperties = { fontFamily: MONO, fontSize: FS.xs + 0.5, color: "var(--text)", padding: "1px 0 1px 6px" };
const tipNum: CSSProperties = { textAlign: "right", paddingLeft: 12 };
