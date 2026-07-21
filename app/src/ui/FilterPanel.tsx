// STUB filter controls — minimal, unstyled. Claude Design will replace this file.
// Contract: it reads `availableTypes` and emits a FilterState via `onChange`.

import type { FilterState } from "../filters";

interface Props {
  availableTypes: string[];
  filter: FilterState;
  onChange: (next: FilterState) => void;
}

/** yyyy-mm-dd string -> epoch seconds (start of that UTC day). */
function dateToTs(value: string): number | undefined {
  if (!value) return undefined;
  return Math.floor(Date.parse(value + "T00:00:00Z") / 1000);
}

/** epoch seconds -> yyyy-mm-dd for <input type=date>. */
function tsToDate(ts?: number): string {
  return ts === undefined ? "" : new Date(ts * 1000).toISOString().slice(0, 10);
}

export function FilterPanel({ availableTypes, filter, onChange }: Props) {
  const toggleType = (t: string) => {
    const types = filter.types.includes(t)
      ? filter.types.filter((x) => x !== t)
      : [...filter.types, t];
    onChange({ ...filter, types });
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: 1,
        background: "rgba(0,0,0,0.7)",
        color: "#fff",
        padding: 12,
        borderRadius: 8,
        font: "13px system-ui, sans-serif",
        maxHeight: "80vh",
        overflow: "auto",
      }}
    >
      <strong>Activity type</strong>
      <div style={{ margin: "6px 0 12px" }}>
        {availableTypes.map((t) => (
          <label key={t} style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={filter.types.includes(t)}
              onChange={() => toggleType(t)}
            />{" "}
            {t}
          </label>
        ))}
      </div>

      <strong>Date range</strong>
      <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
        <label>
          From{" "}
          <input
            type="date"
            value={tsToDate(filter.from)}
            onChange={(e) => onChange({ ...filter, from: dateToTs(e.target.value) })}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            value={tsToDate(filter.to)}
            onChange={(e) => onChange({ ...filter, to: dateToTs(e.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}
