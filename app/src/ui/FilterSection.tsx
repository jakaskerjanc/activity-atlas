// Filter controls: activity-type toggles (with live counts) + date-range sliders.
// Rendered as a section inside the merged SidePanel.

import type { CSSProperties } from "react";
import { MONO, eyebrow } from "./theme";
import { formatMonth } from "../format";

interface Props {
  availableTypes: string[];
  /** count of features of each type within the current date window */
  typeCounts: Record<string, number>;
  /** set of types currently shown */
  enabledTypes: Set<string>;
  onToggleType: (type: string) => void;

  /** month-index bounds of the slider domain (see format.ts: monthIndex). */
  minMonth: number;
  maxMonth: number;
  /** selected bounds, also month indices */
  fromMonth: number;
  toMonth: number;
  onFromChange: (month: number) => void;
  onToChange: (month: number) => void;
}

export function FilterSection({
  availableTypes,
  typeCounts,
  enabledTypes,
  onToggleType,
  minMonth,
  maxMonth,
  fromMonth,
  toMonth,
  onFromChange,
  onToChange,
}: Props) {
  return (
    <>
      <div style={{ ...eyebrow, marginBottom: 8 }}>Activity Types</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {availableTypes.map((t) => {
          const on = enabledTypes.has(t);
          return (
            <button key={t} onClick={() => onToggleType(t)} style={rowStyle(on)}>
              <span style={dotStyle(on)} />
              <span style={{ flex: 1, textAlign: "left" }}>{t}</span>
              <span style={countStyle(on)}>{typeCounts[t] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div style={{ height: 1, background: "var(--divider)", margin: "13px 0" }} />

      <div style={{ ...eyebrow, marginBottom: 6 }}>Date Range</div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--accent-text)", marginBottom: 10 }}>
        {formatMonth(fromMonth)}  →  {formatMonth(toMonth)}
      </div>
      <DualRange
        min={minMonth}
        max={maxMonth}
        from={fromMonth}
        to={toMonth}
        onFromChange={onFromChange}
        onToChange={onToChange}
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
        />
      </div>
      <div style={rangeEnds}>
        <span>{formatMonth(min)}</span>
        <span>{formatMonth(max)}</span>
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

function rowStyle(on: boolean): CSSProperties {
  return {
    ...btnReset,
    display: "flex",
    alignItems: "center",
    gap: 11,
    width: "100%",
    padding: "6px 9px",
    borderRadius: 8,
    background: on ? "var(--accent-tint-weak)" : "transparent",
    color: on ? "var(--text)" : "var(--text-dim)",
    fontSize: 13,
    fontWeight: 500,
    transition: "background .15s",
  };
}

function dotStyle(on: boolean): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: 4,
    flex: "0 0 auto",
    background: on ? "var(--accent)" : "transparent",
    border: on ? "none" : "1.5px solid var(--border-empty)",
    boxShadow: on ? "0 0 10px var(--accent)" : "none",
  };
}

function countStyle(on: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 11,
    color: on ? "var(--text-muted)" : "var(--text-faint)",
  };
}

// Matches the thumb size in index.css; the rail is inset by half of it so the accent
// span's percentages map to thumb-centre positions rather than the raw input box.
const THUMB = 15;

const rangeWrap: CSSProperties = {
  position: "relative",
  height: 16,
  margin: "2px 0 4px",
};

const rail: CSSProperties = {
  position: "absolute",
  left: THUMB / 2,
  right: THUMB / 2,
  top: "50%",
  transform: "translateY(-50%)",
  height: 3,
  borderRadius: 3,
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
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-muted)",
};
