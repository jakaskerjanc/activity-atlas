// Filter controls: activity-type toggles, one per type row (most activities first, with
// live counts; rare types share the Workout row), date-range sliders and the places list
// (PlacesSection). Rendered as a section inside the SidePanel.
// In the map's Type color mode each toggle's swatch takes its type's route color, so the
// list doubles as the map's legend.

import { useMemo, type CSSProperties } from "react";
import { FS, sectionLabel } from "./theme";
import { countStyle, divider, rowStyle } from "./filterStyles";
import { PlacesSection } from "./PlacesSection";
import { formatMonth, formatMonthShort, typeLabel } from "../format";
import { typeColor, type ColorMode } from "../colors";
import type { Place, Theme } from "../types";
import {
  isRowOn,
  setFromMonth,
  setToMonth,
  toggleRow,
  typeCounts,
  typeRows,
  type ActivityFilter,
} from "../activityFilter";

interface Props {
  filter: ActivityFilter;
  onChange: (filter: ActivityFilter) => void;
  /** The places the activities reach (places.json); none hides the places list. */
  places: readonly Place[];
  /** In Type mode the swatches show each type's route color. */
  colorMode?: ColorMode;
  theme?: Theme;
}

export function FilterSection({ filter, onChange, places, colorMode, theme = "dark" }: Props) {
  // Memoized: the side panel re-renders with App (a selection, a page switch, a panel
  // opening), and the filter only changes on input.
  const counts = useMemo(() => typeCounts(filter), [filter]);
  const rows = useMemo(() => typeRows(filter), [filter]);
  const byType = colorMode === "type";
  return (
    <>
      <h3 style={{ ...sectionLabel, marginBottom: 8 }}>Activity types</h3>
      <div role="group" aria-label="Activity types" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map(({ type, members }) => {
          const on = isRowOn(filter, type);
          const color = byType ? typeColor(type, theme) : "var(--accent)";
          const count = members.reduce((n, t) => n + (counts[t] ?? 0), 0);
          // A row holding rarer types names them, so they can be found.
          const others = members.filter((t) => t !== type);
          const title = others.length
            ? `${typeLabel(type)}, with ${others.map((t) => typeLabel(t).toLowerCase()).join(", ")}`
            : undefined;
          return (
            <button
              key={type}
              type="button"
              className="ctl"
              aria-pressed={on}
              title={title}
              onClick={() => onChange(toggleRow(filter, type))}
              style={rowStyle(on)}
            >
              <span style={dotStyle(on, color)}>{on && <Check />}</span>
              <span style={{ flex: 1, textAlign: "left" }}>{typeLabel(type)}</span>
              <span style={countStyle(on)}>{count}</span>
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

      {/* Last: its list grows and shrinks with the filter, so nothing below it jumps. */}
      <PlacesSection filter={filter} places={places} onChange={onChange} />
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
  // The later input sits on top, so where the thumbs overlap it takes the drag. Put the
  // one with room to move there instead: with both at the end, the end thumb can go
  // neither right (max) nor left (it can't pass the start), so the start thumb must
  // be the one grabbed. Overlapping at the start, the end thumb must be.
  const fromOnTop = from - min > max - to;

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
          style={{ zIndex: fromOnTop ? 2 : 1 }}
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
          style={{ zIndex: fromOnTop ? 1 : 2 }}
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

/** A checkmark drawn in the swatch, so on/off never rests on color alone. */
function Check() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
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
