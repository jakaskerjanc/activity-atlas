// Bottom-center panel: aggregate totals, or a single activity's stats when selected.

import { GlassPanel } from "./GlassPanel";
import { StatsSection } from "./StatsSection";
import { BOTTOM_PANEL_INSET_X, BOTTOM_PANEL_WIDTH } from "./layout";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  link: { url: string; label: string } | null;
  /** Collapsed off the bottom edge, leaving its title strip visible to click. */
  collapsed: boolean;
  onToggle: () => void;
}

export function InfoPanel(p: Props) {
  return (
    <GlassPanel
      anchor={{ bottom: 24, centerX: true }}
      width={BOTTOM_PANEL_WIDTH}
      maxWidth="calc(100vw - 84px)"
      insetX={BOTTOM_PANEL_INSET_X}
      insetY={18}
      collapsed={p.collapsed}
      onToggleCollapse={p.onToggle}
      collapseEdge="bottom"
      collapseLabel="details"
    >
      <StatsSection
        title={p.title}
        subtitle={p.subtitle}
        cards={p.cards}
        link={p.link}
      />
    </GlassPanel>
  );
}
