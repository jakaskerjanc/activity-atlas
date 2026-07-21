// Color-mode selector + legend. Chooses how routes are colored on the map
// (uniform / recency / type / elevation / speed / heat) and shows the matching
// scale. Rendered as a section inside the SidePanel.

import type { CSSProperties } from "react";
import { ACCENT, MONO, eyebrow } from "./theme";
import {
  COLOR_MODES,
  legendFor,
  type ColorMode,
  type ColorDomain,
  type Legend,
} from "../colors";

interface Props {
  mode: ColorMode;
  domain: ColorDomain;
  onChange: (mode: ColorMode) => void;
}

export function ColorSection({ mode, domain, onChange }: Props) {
  return (
    <>
      <div style={{ ...eyebrow, marginBottom: 8 }}>Color</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {COLOR_MODES.map(({ mode: m, label }) => (
          <button key={m} onClick={() => onChange(m)} style={pillStyle(m === mode)}>
            {label}
          </button>
        ))}
      </div>
      <LegendView legend={legendFor(mode, domain)} />
    </>
  );
}

function LegendView({ legend }: { legend: Legend }) {
  if (legend.kind === "none") return null;

  if (legend.kind === "categorical") {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 12 }}>
        {legend.entries.map((e) => (
          <div key={e.label} style={swatchRow}>
            <span style={{ ...swatchDot, background: e.color }} />
            <span>{e.label}</span>
          </div>
        ))}
      </div>
    );
  }

  // gradient
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: `linear-gradient(90deg, ${legend.stops.join(", ")})`,
        }}
      />
      <div style={gradientLabels}>
        <span>{legend.minLabel}</span>
        <span>{legend.maxLabel}</span>
      </div>
    </div>
  );
}

function pillStyle(on: boolean): CSSProperties {
  return {
    appearance: "none",
    border: on ? `1px solid ${ACCENT}` : "1px solid rgba(255,255,255,.12)",
    cursor: "pointer",
    padding: "5px 10px",
    borderRadius: 8,
    background: on ? "rgba(255,107,61,.14)" : "transparent",
    color: on ? "#eceef2" : "#8b8f99",
    fontSize: 12,
    fontWeight: 500,
    transition: "background .15s, border-color .15s",
  };
}

const swatchRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 12,
  color: "#b7bac2",
};

const swatchDot: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 3,
  flex: "0 0 auto",
};

const gradientLabels: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginTop: 6,
  fontFamily: MONO,
  fontSize: 10,
  color: "#8b8f99",
};
