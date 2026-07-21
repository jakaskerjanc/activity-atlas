// The single merged panel: activity stats on top, filter controls below.

import { PANEL_STYLE, divider } from "./theme";
import { StatsSection } from "./StatsSection";
import { FilterSection } from "./FilterSection";
import type { StatCard } from "../stats";

interface Props {
  // stats
  title: string;
  subtitle: string;
  cards: StatCard[];
  selected: boolean;
  onClearSelection: () => void;
  // filters
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
    <aside style={PANEL_STYLE}>
      <StatsSection
        title={p.title}
        subtitle={p.subtitle}
        cards={p.cards}
        selected={p.selected}
        onClearSelection={p.onClearSelection}
      />
      <div style={divider} />
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
