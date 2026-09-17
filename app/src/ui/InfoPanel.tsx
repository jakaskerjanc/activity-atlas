// Bottom-center panel: aggregate totals, or a single activity's stats when selected.

import { GlassPanel } from "./GlassPanel";
import { StatsSection } from "./StatsSection";
import { MOBILE_QUERY, SIDE_PANEL_CLEARANCE } from "./SidePanel";
import { useMediaQuery } from "./useMediaQuery";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  link: { url: string; label: string } | null;
}

export function InfoPanel(p: Props) {
  // SidePanel renders above the mobile breakpoint; clear it instead of overlapping.
  const sidePanelVisible = !useMediaQuery(MOBILE_QUERY);

  return (
    <GlassPanel
      anchor={{
        bottom: 24,
        centerX: true,
        avoidLeft: sidePanelVisible ? SIDE_PANEL_CLEARANCE : undefined,
      }}
      width={420}
      maxWidth="calc(100vw - 84px)"
      insetX={18}
      insetY={18}
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
