// Bottom-center panel: aggregate totals, or a single activity's stats when selected.

import { INFO_PANEL_STYLE } from "./theme";
import { StatsSection } from "./StatsSection";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  stravaUrl: string | null;
}

export function InfoPanel(p: Props) {
  return (
    <aside style={INFO_PANEL_STYLE}>
      <StatsSection
        title={p.title}
        subtitle={p.subtitle}
        cards={p.cards}
        stravaUrl={p.stravaUrl}
      />
    </aside>
  );
}
