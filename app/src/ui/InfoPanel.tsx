// Bottom-center panel: aggregate totals, or a single activity's stats when selected.

import { GlassPanel } from "./GlassPanel";
import { StatsSection } from "./StatsSection";
import type { StatCard } from "../stats";
import type { Theme } from "../types";

interface Props {
  theme: Theme;
  title: string;
  subtitle: string;
  cards: StatCard[];
  stravaUrl: string | null;
}

export function InfoPanel(p: Props) {
  return (
    <GlassPanel
      theme={p.theme}
      anchor={{ bottom: 24, centerX: true }}
      width={420}
      maxWidth="calc(100vw - 80px)"
    >
      <StatsSection
        title={p.title}
        subtitle={p.subtitle}
        cards={p.cards}
        stravaUrl={p.stravaUrl}
      />
    </GlassPanel>
  );
}
