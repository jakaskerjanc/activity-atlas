// Route color selector + legend. Chooses how routes are colored on the map (plain /
// type / recency / grade / speed / heat) and shows the matching scale. Rendered as a
// section inside the SidePanel. In Type mode the type list above is the legend.

import type { CSSProperties } from "react";
import { FS, pillStyle, sectionLabel } from "./theme";
import {
  COLOR_MODES,
  legendFor,
  type ColorMode,
  type ColorDomain,
  type Legend,
} from "../colors";
import type { Theme } from "../types";

interface Props {
  mode: ColorMode;
  domain: ColorDomain;
  theme?: Theme;
  onChange: (mode: ColorMode) => void;
}

export function ColorSection({ mode, domain, theme = "dark", onChange }: Props) {
  const hint = COLOR_MODES.find((m) => m.mode === mode)?.hint;
  return (
    <>
      <h3 style={{ ...sectionLabel, marginBottom: 8 }}>Route color</h3>
      <div role="group" aria-label="Route color" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {COLOR_MODES.map(({ mode: m, label, hint }) => (
          <button
            key={m}
            type="button"
            className={m === mode ? undefined : "ctl"}
            aria-pressed={m === mode}
            title={hint}
            onClick={() => onChange(m)}
            style={pillStyle(m === mode)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* One fixed-height slot: the scale's legend, or (Plain, Type) a line saying what the
          mode does, so switching modes never moves the Replay button. */}
      <div style={slot}>
        {(() => {
          const legend = legendFor(mode, domain, theme);
          if (legend.kind === "gradient") return <LegendView legend={legend} />;
          return <p style={hintStyle}>{mode === "type" ? "Each type's color is shown in the list above." : hint}</p>;
        })()}
      </div>
    </>
  );
}

function LegendView({ legend }: { legend: Legend }) {
  // Categorical (Type mode): the type list's swatches already are the legend.
  if (legend.kind !== "gradient") return null;
  return (
    <div>
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: `linear-gradient(90deg, ${legend.stops.join(", ")})`,
        }}
      />
      <div style={gradientLabels}>
        <span>{legend.minLabel}</span>
        {legend.midLabel != null && <span>{legend.midLabel}</span>}
        <span>{legend.maxLabel}</span>
      </div>
    </div>
  );
}

const slot: CSSProperties = { height: 40, marginTop: 10 };

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: FS.xs + 0.5,
  lineHeight: 1.4,
  color: "var(--text-muted)",
};

const gradientLabels: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginTop: 6,
  fontSize: FS.xs,
  color: "var(--text-muted)",
};
