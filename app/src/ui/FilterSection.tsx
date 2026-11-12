// Filter controls: activity-type toggles (most activities first, with live counts; rare
// types left out) + date-range sliders. Rendered as a section inside the SidePanel.
// In the map's Type color mode each toggle's swatch takes its type's route color, so the
// list doubles as the map's legend.

import { useMemo, type CSSProperties } from "react";
import { FS, MONO, R, sectionLabel } from "./theme";
import { formatMonth, formatMonthShort, typeLabel } from "../format";
import { typeColor, type ColorMode } from "../colors";
import type { Theme } from "../types";
import {
  setFromMonth,
  setToMonth,
  toggleType,
  typeCounts,
  listedTypes,
  type ActivityFilter,
} from "../activityFilter";

interface Props {
  filter: ActivityFilter;
  onChange: (filter: ActivityFilter) => void;
  /** In Type mode the swatches show each type's route color. */
  colorMode?: ColorMode;
  theme?: Theme;
}

export function FilterSection({ filter, onChange, colorMode, theme = "dark" }: Props) {
  // Memoized: App re-renders every replay frame, and the filter only changes on input.
  const counts = useMemo(() => typeCounts(filter), [filter]);
  const types = useMemo(() => listedTypes(filter), [filter]);
  const byType = colorMode === "type";
  return (
    <>
      <h3 style={{ ...sectionLabel, marginBottom: 8 }}>Activity types</h3>
      <div role="group" aria-label="Activity types" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {types.map((t) => {
          const on = filter.types.has(t);
          const color = byType ? typeColor(t, theme) : "var(--accent)";
          return (
            <button
              key={t}
              type="button"
              className="ctl"
              aria-pressed={on}
              onClick={() => onChange(toggleType(filter, t))}
              style={rowStyle(on)}
            >
              <span style={dotStyle(on, color)}>{on && <Check />}</span>
              <span style={{ flex: 1, textAlign: "left" }}>{typeLabel(t)}</span>
              <span style={countStyle(on)}>{counts[t] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <hr style={divider} />

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
        <h3 style={sectionLabel}>Date range</h3>
        <span style={{ fontSize: FS.sm, fontWeight: 600, color: "var(--text)" }} aria-live="polite">
          {formatMonthShort(filter.fromMonth)} – {formatMonthShort(filter.toMonth)}
        </span>
      </div>
      <DualRange
        min={filter.minMonth}
        max={filter.maxMonth}
        from={filter.fromMonth}
        to={filter.toMonth}
        onFromChange={(m) => onChange(setFromMonth(filter, m))}
        onToChange={(m) => onChange(setToMonth(filter, m))}
      />
    </>
  );
}

/**
 * One rail with two draggable thumbs, so the lit segment reads as the active window.
 * Native range inputs are single-thumb, so this overlays two of them: the inputs are
 * pointer-transparent and only their thumbs take pointer events (see .range-dual in
 * index.css), and the accent span is painted on the rail between the two values.
 */
function DualRange({
  min,
  max,
  from,
  to,
  onFromChange,
  onToChange,
}: {
  min: number;
  max: number;
  from: number;
  to: number;
  onFromChange: (month: number) => void;
  onToChange: (month: number) => void;
}) {
  const span = max - min;
  const pctFrom = span > 0 ? ((from - min) / span) * 100 : 0;
  const pctTo = span > 0 ? ((to - min) / span) * 100 : 100;

  return (
    <>
      <div style={rangeWrap}>
        {/* Inset by half a thumb so the fill's 0..100% lines up with the thumb centres. */}
        <div style={rail}>
          <div style={{ ...windowFill, left: `${pctFrom}%`, right: `${100 - pctTo}%` }} />
        </div>
        <input
          type="range"
          className="range-dual"
          min={min}
          max={max}
          step={1}
          value={from}
          onChange={(e) => onFromChange(+e.target.value)}
          aria-label="Earliest month"
          aria-valuetext={formatMonth(from)}
        />
        <input
          type="range"
          className="range-dual"
          min={min}
          max={max}
          step={1}
          value={to}
          onChange={(e) => onToChange(+e.target.value)}
          aria-label="Latest month"
          aria-valuetext={formatMonth(to)}
        />
      </div>
      <div style={rangeEnds}>
        <span>{formatMonthShort(min)}</span>
        <span>{formatMonthShort(max)}</span>
      </div>
    </>
  );
}

const btnReset: CSSProperties = {
  appearance: "none",
  border: "none",
  font: "inherit",
  cursor: "pointer",
};

/** A checkmark drawn in the swatch, so on/off never rests on color alone. */
function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const divider: CSSProperties = {
  border: 0,
  height: 1,
  background: "var(--divider)",
  margin: "16px 0",
};

function rowStyle(on: boolean): CSSProperties {
  return {
    ...btnReset,
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    height: 34,
    padding: "0 10px",
    borderRadius: R.sm,
    backgroundColor: "transparent",
    color: on ? "var(--text)" : "var(--text-dim)",
    fontSize: FS.md - 0.5,
    fontWeight: 500,
  };
}

function dotStyle(on: boolean, color: string): CSSProperties {
  return {
    width: 16,
    height: 16,
    borderRadius: 5,
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    background: on ? color : "transparent",
    border: on ? "none" : "1.5px solid var(--border-empty)",
  };
}

function countStyle(on: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: FS.xs + 0.5,
    color: on ? "var(--text-muted)" : "var(--text-faint)",
  };
}

// Matches the thumb size in index.css; the rail is inset by half of it so the accent
// span's percentages map to thumb-centre positions rather than the raw input box.
const THUMB = 16;

// 24 px tall: the minimum pointer target (WCAG 2.5.8), the inputs filling it.
const rangeWrap: CSSProperties = {
  position: "relative",
  height: 24,
  margin: "-2px 0 4px",
};

const rail: CSSProperties = {
  position: "absolute",
  left: THUMB / 2,
  right: THUMB / 2,
  top: "50%",
  transform: "translateY(-50%)",
  height: 4,
  borderRadius: 4,
  background: "var(--track)",
};

const windowFill: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "var(--accent)",
  borderRadius: 3,
};

const rangeEnds: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: FS.xs,
  color: "var(--text-muted)",
};
