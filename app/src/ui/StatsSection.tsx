// Stats: aggregate totals, or a single activity's stats when one is selected.
// Rendered as a section inside the merged SidePanel.

import type { CSSProperties } from "react";
import { ACCENT, MONO } from "./theme";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  selected: boolean;
  onClearSelection: () => void;
}

export function StatsSection({
  title,
  subtitle,
  cards,
  selected,
  onClearSelection,
}: Props) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 15,
              fontWeight: 700,
              color: "#eceef2",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 10,
              letterSpacing: ".14em",
              color: "#8b8f99",
              textTransform: "uppercase",
              fontFamily: MONO,
              marginTop: 4,
            }}
          >
            {subtitle}
          </span>
        </span>
        {selected && (
          <button onClick={onClearSelection} style={clearBtn}>
            ✕ ALL
          </button>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
          background: "rgba(255,255,255,.07)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {cards.map((c) => (
          <div key={c.label} style={{ background: "rgba(20,22,28,.9)", padding: "10px 12px" }}>
            <div style={c.accent ? accentVal : bigVal}>{c.value}</div>
            <div
              style={{
                fontSize: 10,
                letterSpacing: ".12em",
                color: "#8b8f99",
                textTransform: "uppercase",
                marginTop: 3,
              }}
            >
              {c.label}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const bigVal: CSSProperties = {
  fontFamily: MONO,
  fontSize: 21,
  fontWeight: 600,
  color: "#fff",
};
const accentVal: CSSProperties = { ...bigVal, color: ACCENT };

const clearBtn: CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(255,255,255,.14)",
  background: "rgba(255,255,255,.04)",
  color: "#b7bac2",
  fontSize: 11,
  fontWeight: 600,
  padding: "6px 11px",
  borderRadius: 8,
  cursor: "pointer",
  fontFamily: MONO,
  whiteSpace: "nowrap",
};
