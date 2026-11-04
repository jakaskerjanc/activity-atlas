// Bottom-center panel: aggregate totals, or a single activity's stats when selected.

import type { ReactNode } from "react";
import { GlassPanel } from "./GlassPanel";
import { StatsSection } from "./StatsSection";
import { BOTTOM_PANEL_INSET_X, BOTTOM_PANEL_WIDTH } from "./layout";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  links: { url: string; label: string }[];
  /** Rendered under the cards: the selected activity's charts or a status line. */
  body?: ReactNode;
  /** Cards in one row of four, to leave room for charts. */
  compactCards?: boolean;
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
      // Charts make the panel tall; past this it scrolls rather than leaving the screen.
      maxHeight="calc(100vh - 140px)"
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
        links={p.links}
        compact={p.compactCards}
      />
      {p.body}
    </GlassPanel>
  );
}
