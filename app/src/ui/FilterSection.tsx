// Filter controls: activity-type toggles (with live counts) + date-range sliders.
// Rendered as a section inside the merged SidePanel.

import type { CSSProperties } from "react";
import { MONO, eyebrow } from "./theme";
import { formatDate } from "../format";

interface Props {
  availableTypes: string[];
  /** count of features of each type within the current date window */
  typeCounts: Record<string, number>;
  /** set of types currently shown */
  enabledTypes: Set<string>;
  onToggleType: (type: string) => void;

  tsMin: number;
  tsMax: number;
  /** current bounds (default to full range) */
  from: number;
  to: number;
  onFromChange: (ts: number) => void;
  onToChange: (ts: number) => void;
}

const DAY = 86400;

export function FilterSection({
  availableTypes,
  typeCounts,
  enabledTypes,
  onToggleType,
  tsMin,
  tsMax,
  from,
  to,
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
      <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--accent-text)", marginBottom: 12 }}>
        {formatDate(from)}  →  {formatDate(to)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={sliderLabelRow}>
            <span>EARLIEST</span>
            <span>{formatDate(from)}</span>
          </div>
          <input
            type="range"
            min={tsMin}
            max={tsMax}
            step={DAY}
            value={from}
            onChange={(e) => onFromChange(+e.target.value)}
          />
        </div>
        <div>
          <div style={sliderLabelRow}>
            <span>LATEST</span>
            <span>{formatDate(to)}</span>
          </div>
          <input
            type="range"
            min={tsMin}
            max={tsMax}
            step={DAY}
            value={to}
            onChange={(e) => onToChange(+e.target.value)}
          />
        </div>
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

const sliderLabelRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 10,
  color: "var(--text-muted)",
  marginBottom: 6,
  fontFamily: MONO,
};
