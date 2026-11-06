// The detail panel: aggregate totals, the selected activity's stats and charts, or the
// shown city route. Docked top-right on desktop, where it collapses to its title strip;
// on a phone it is a bottom sheet whose collapsed state (the peek) is that same strip.

import type { CSSProperties, ReactNode } from "react";
import { GlassPanel } from "./GlassPanel";
import { PanelHeader } from "./PanelHeader";
import { StatGrid } from "./StatsSection";
import { ChevronIcon } from "./icons";
import { DETAIL_PANEL_WIDTH, PANEL_EDGE, PANEL_TOP, SHEET_MAX_WIDTH } from "./layout";
import type { StatCard } from "../stats";
import type { ActivityLink } from "../format";

interface Props {
  title: string;
  titleNode?: ReactNode;
  /** Back to all activities: closes the selected activity or the shown city route. */
  onClose?: () => void;
  closeLabel?: string;
  subtitle: string;
  cards: StatCard[];
  /** The activity's pages on Garmin Connect / Strava, shown as "G" / "S" badges. */
  links: ActivityLink[];
  /** Rendered under the cards: the selected activity's charts or a status line. */
  body?: ReactNode;
  /** Replaces the cards: what to say (and offer) when nothing is shown. */
  notice?: ReactNode;
  /** Cards in one row of four, to leave room for charts. */
  compactCards?: boolean;
  /** Only the title strip shows. */
  collapsed: boolean;
  onToggle: () => void;
  /** The phone layout: a bottom sheet. */
  mobile?: boolean;
  /** Reports the panel's height (the phone's sheet covers the map's bottom edge). */
  onHeight?: (height: number) => void;
}

export function InfoPanel(p: Props) {
  const placement: CSSProperties = p.mobile
    ? { left: 0, right: 0, bottom: 0, margin: "0 auto", maxWidth: SHEET_MAX_WIDTH, maxHeight: "min(72%, calc(100% - 140px))" }
    : {
        top: PANEL_TOP,
        right: PANEL_EDGE,
        width: DETAIL_PANEL_WIDTH,
        maxHeight: `calc(100% - ${PANEL_TOP + PANEL_EDGE}px)`,
      };
  return (
    <GlassPanel
      id="detail-panel"
      label="Details"
      placement={placement}
      className={p.mobile ? "panel--sheet" : undefined}
      collapsed={p.collapsed}
      onHeight={p.onHeight}
      header={
        <PanelHeader
          title={p.title}
          titleNode={p.titleNode}
          close={p.onClose ? { label: p.closeLabel ?? "Close", onClick: p.onClose } : undefined}
          links={p.links}
          subtitle={p.subtitle}
          sheet={p.mobile}
          action={{
            label: `${p.collapsed ? "Expand" : "Collapse"} details`,
            icon: <ChevronIcon dir={p.collapsed === !p.mobile ? "down" : "up"} />,
            onClick: p.onToggle,
            expanded: !p.collapsed,
            controls: "detail-panel",
          }}
        />
      }
    >
      {p.notice ?? <StatGrid cards={p.cards} compact={p.compactCards} />}
      {p.body}
    </GlassPanel>
  );
}
