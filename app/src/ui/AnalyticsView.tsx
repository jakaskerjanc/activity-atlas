// Analytics page: numbers about the visible activities, on a surface that covers the map.
// The side panel stays beside it with the same Activity filter, so every figure here
// describes exactly the activities the map draws.

import { useMemo, type CSSProperties } from "react";
import { SectionHeading, StatsSection } from "./StatsSection";
import { ActivityCalendar, CALENDAR_WIDTH } from "./ActivityCalendar";
import { eyebrow, glass } from "./theme";
import { useMediaQuery } from "./useMediaQuery";
import {
  COLLAPSE_QUERY,
  PANEL_TAB_SIZE,
  SIDE_PANEL_CLEARANCE,
  SIDE_PANEL_GAP,
  SIDE_PANEL_LEFT,
  SIDE_PANEL_TOP,
} from "./layout";
import { rangeTs, type ActivityFilter } from "../activityFilter";
import { activityCalendar, consistency, consistencyCards } from "../analytics";
import { formatMonth } from "../format";
import type { ActivityFeature } from "../types";

interface Props {
  /** null until the data loads. */
  filter: ActivityFilter | null;
  visible: ActivityFeature[];
  sidePanelExpanded: boolean;
}

const EDGE = 24;
// Leftmost the content may sit: a gap past the side panel's edge tab, which protrudes
// beyond the panel when open and is all that's left of it when collapsed.
const EXPANDED_LEFT = SIDE_PANEL_CLEARANCE + PANEL_TAB_SIZE;
const COLLAPSED_LEFT = SIDE_PANEL_LEFT + PANEL_TAB_SIZE + SIDE_PANEL_GAP;
const CARD_PADDING = 18;
// The content column fits a year of the activity calendar at its natural cell size.
const COLUMN_WIDTH = CALENDAR_WIDTH + 2 * CARD_PADDING;
// Below this the stat cards fall back from one row of four to the 2x2 grid.
const STATS_ROW_QUERY = "(max-width: 640px)";

export function AnalyticsView({ filter, visible, sidePanelExpanded }: Props) {
  // On a narrow screen an opened side panel overlays the page, as it does the map,
  // instead of squeezing the content off-screen.
  const narrow = useMediaQuery(COLLAPSE_QUERY);
  const left = sidePanelExpanded && !narrow ? EXPANDED_LEFT : COLLAPSED_LEFT;
  const statColumns = useMediaQuery(STATS_ROW_QUERY) ? 2 : 4;

  const { cards, calendar } = useMemo(() => {
    if (!filter) return { cards: [], calendar: [] };
    // Stop the range at now, so a range ending this month doesn't count days still to come.
    const [from, to] = rangeTs(filter);
    const end = Math.min(to, Date.now() / 1000);
    return {
      cards: consistencyCards(consistency(visible, from, end)),
      calendar: activityCalendar(visible, from, end),
    };
  }, [filter, visible]);

  return (
    <main
      aria-label="Analytics"
      style={{
        ...page,
        // Equal 1fr side tracks center the column on the page, like the map's bottom
        // panel. When the page is too narrow for that, the left track holds its minimum
        // and the column shifts right, clear of the side panel.
        gridTemplateColumns: `minmax(${left}px, 1fr) minmax(0, ${COLUMN_WIDTH}px) minmax(${EDGE}px, 1fr)`,
      }}
    >
      <div style={{ gridColumn: 2 }}>
        <h1 style={heading}>Analytics</h1>
        {filter && (
          <>
            <div style={{ ...eyebrow, marginTop: 6 }}>
              {formatMonth(filter.fromMonth)} — {formatMonth(filter.toMonth)}
            </div>
            {visible.length === 0 ? (
              <p style={emptyText}>
                No activities match the filter. Switch on an activity type or widen the date
                range.
              </p>
            ) : (
              <>
                <section style={card}>
                  <StatsSection
                    title="Consistency"
                    subtitle="Streaks and weekly averages"
                    cards={cards}
                    columns={statColumns}
                  />
                </section>
                <section style={card}>
                  <SectionHeading title="Activity calendar" subtitle="Moving time per day (UTC)" />
                  <ActivityCalendar years={calendar} />
                </section>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

const page: CSSProperties = {
  position: "absolute",
  inset: 0,
  // Over the map and its vignette, under the panels (20) and the header (30).
  zIndex: 15,
  overflowY: "auto",
  boxSizing: "border-box",
  background: "var(--bg)",
  display: "grid",
  alignContent: "start",
  paddingTop: SIDE_PANEL_TOP,
  paddingBottom: EDGE,
  // Tracks the side panel's slide.
  transition: "grid-template-columns .28s ease",
};

const heading: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: ".02em",
  color: "var(--text-strong)",
};

const card: CSSProperties = {
  ...glass,
  borderRadius: 16,
  padding: CARD_PADDING,
  marginTop: 18,
};

const emptyText: CSSProperties = {
  marginTop: 18,
  fontSize: 13,
  color: "var(--text-muted)",
};
