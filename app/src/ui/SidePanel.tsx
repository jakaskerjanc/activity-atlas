// Left panel: filter controls only. Activity/aggregate stats live in InfoPanel.

import { PANEL_STYLE } from "./theme";
import { FilterSection } from "./FilterSection";

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
    </aside>
  );
}
