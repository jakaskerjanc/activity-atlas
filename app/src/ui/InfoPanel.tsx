// Bottom-center panel: aggregate totals, or a single activity's stats when selected.

import { GlassPanel } from "./GlassPanel";
import { StatsSection } from "./StatsSection";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  link: { url: string; label: string } | null;
}

export function InfoPanel(p: Props) {
  return (
    <GlassPanel
      anchor={{ bottom: 24, centerX: true }}
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
