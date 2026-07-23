// Left panel: filter controls + color-mode selector. Activity/aggregate stats
// live in InfoPanel.

import type { CSSProperties } from "react";
import { PANEL_STYLE } from "./theme";
import { FilterSection } from "./FilterSection";
import { ColorSection } from "./ColorSection";
import type { ColorMode, ColorDomain } from "../colors";

interface Props {
  availableTypes: string[];
  typeCounts: Record<string, number>;
  enabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  tsMin: number;
  tsMax: number;
  from: number;
  to: number;
  onFromChange: (ts: number) => void;
  onToChange: (ts: number) => void;
  colorMode: ColorMode;
  colorDomain: ColorDomain;
  onColorModeChange: (mode: ColorMode) => void;
  /** Start chronological replay of the currently filtered set. */
  onStartReplay: () => void;
  /** False when the filter leaves nothing to replay. */
  canReplay: boolean;
}

export function SidePanel(p: Props) {
  return (
    <aside className="side-panel" style={PANEL_STYLE}>
      <FilterSection
        availableTypes={p.availableTypes}
        typeCounts={p.typeCounts}
        enabledTypes={p.enabledTypes}
        onToggleType={p.onToggleType}
        tsMin={p.tsMin}
        tsMax={p.tsMax}
        from={p.from}
        to={p.to}
        onFromChange={p.onFromChange}
        onToChange={p.onToChange}
      />
      <div style={{ height: 1, background: "var(--divider)", margin: "13px 0" }} />
      <ColorSection
        mode={p.colorMode}
        domain={p.colorDomain}
        onChange={p.onColorModeChange}
      />
      <div style={{ height: 1, background: "var(--divider)", margin: "13px 0" }} />
      <button
        onClick={p.onStartReplay}
        disabled={!p.canReplay}
        style={replayBtn(p.canReplay)}
      >
        ▶  Replay history
      </button>
    </aside>
  );
}

function replayBtn(enabled: boolean): CSSProperties {
  return {
    appearance: "none",
    cursor: enabled ? "pointer" : "not-allowed",
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: `1px solid ${enabled ? "var(--accent)" : "var(--control-border)"}`,
    background: enabled ? "var(--accent-tint)" : "transparent",
    color: enabled ? "var(--pill-on-text)" : "var(--text-faint)",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: ".02em",
  };
}
