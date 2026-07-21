// Left panel: filter controls + color-mode selector. Activity/aggregate stats
// live in InfoPanel.

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
      <div style={{ height: 1, background: "rgba(255,255,255,.08)", margin: "13px 0" }} />
      <ColorSection
        mode={p.colorMode}
        domain={p.colorDomain}
        onChange={p.onColorModeChange}
      />
    </aside>
  );
}
