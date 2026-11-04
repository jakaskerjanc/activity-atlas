// Analytics page: numbers about the visible activities, on a surface that covers the map.
// The side panel stays beside it with the same Activity filter. Every figure here covers
// the visible activities with or without a route; the map draws the routed ones, and its
// totals cover the same visible set, so the two pages' totals are the same numbers.

import { useMemo, type CSSProperties } from "react";
import { SectionHeading, StatsSection } from "./StatsSection";
import { ActivityCalendar, CALENDAR_WIDTH } from "./ActivityCalendar";
import { Ridgeline } from "./Ridgeline";
import { ElevationProfiles } from "./ElevationProfiles";
import { useRouteProfiles, type ProfilesState } from "./useRouteProfiles";
import { eyebrow, glass, MONO } from "./theme";
import { useMediaQuery } from "./useMediaQuery";
import {
  COLLAPSE_QUERY,
  PANEL_TAB_SIZE,
  SIDE_PANEL_CLEARANCE,
  SIDE_PANEL_GAP,
  SIDE_PANEL_LEFT,
  SIDE_PANEL_TOP,
} from "./layout";
import {
  rangeTs,
  typesByCount,
  type ActivityFilter,
  type MonthIsolation,
} from "../activityFilter";
import { activityCalendar, consistency, consistencyCards } from "../analytics";
import { climbingRidgeline } from "../ridgeline";
import { profileChart } from "../elevationProfiles";
import { totalCards } from "../stats";
import { formatMonth } from "../format";
import type { ActivityRecord } from "../types";

interface Props {
  /** null until the data loads. */
  filter: ActivityFilter | null;
  /** The visible activities, as App hands them to the map's totals too. */
  visible: ActivityRecord[];
  sidePanelExpanded: boolean;
  /** A month isolated from the ridgeline, while the range is still just that month. */
  isolation: MonthIsolation | null;
  /** A ridgeline row was clicked: isolate that month, or restore the range before. */
  onPickMonth: (month: number) => void;
  /** The route profiles' load state; tests pass one in, the page fetches them otherwise. */
  profiles?: ProfilesState;
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

export function AnalyticsView({
  filter,
  visible,
  sidePanelExpanded,
  isolation,
  onPickMonth,
  profiles: given,
}: Props) {
  const fetched = useRouteProfiles();
  const profiles = given ?? fetched;
  // On a narrow screen an opened side panel overlays the page, as it does the map,
  // instead of squeezing the content off-screen.
  const narrow = useMediaQuery(COLLAPSE_QUERY);
  const left = sidePanelExpanded && !narrow ? EXPANDED_LEFT : COLLAPSED_LEFT;
  const statColumns = useMediaQuery(STATS_ROW_QUERY) ? 2 : 4;

  const { totals, cards, calendar } = useMemo(() => {
    if (!filter) return { totals: [], cards: [], calendar: [] };
    // Stop the range at now, so a range ending this month doesn't count days still to come.
    const [from, to] = rangeTs(filter);
    const end = Math.min(to, Date.now() / 1000);
    return {
      // The map panel's aggregate cards, from the same function and the same activities.
      totals: totalCards(visible),
      cards: consistencyCards(consistency(visible, from, end)),
      calendar: activityCalendar(visible, from, end),
    };
  }, [filter, visible]);

  const ridgeline = useMemo(
    () => (filter ? climbingRidgeline(visible, filter.fromMonth, filter.toMonth) : null),
    [filter, visible],
  );

  // Colors by how common a type is overall, so the few types with profiles get distinct
  // colors (the map's alphabetical palette wraps past 8 types) and keep them while the
  // filter changes.
  const typeOrder = useMemo(() => (filter ? typesByCount(filter) : []), [filter]);

  const chart = useMemo(() => {
    if (profiles.status !== "ready") return null;
    const { profiles: byId, step } = profiles.file;
    const lines = visible.flatMap((a) => {
      const profile = byId[a.id];
      return profile ? [{ id: a.id, name: a.name, type: a.type, ts: a.ts, profile }] : [];
    });
    return profileChart(lines, step);
  }, [visible, profiles]);

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
                    title="Totals"
                    subtitle="Distance, climbing and time"
                    cards={totals}
                    columns={statColumns}
                  />
                </section>
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
                <section style={card}>
                  <SectionHeading
                    title="Climbing by month"
                    subtitle={
                      isolation
                        ? `Click ${formatMonth(isolation.month)} again for ${formatMonth(isolation.fromMonth)} — ${formatMonth(isolation.toMonth)}`
                        : "Elevation gain per day, and total · click a month to show only it"
                    }
                  />
                  {ridgeline && (
                    <Ridgeline
                      ridgeline={ridgeline}
                      isolatedMonth={isolation?.month ?? null}
                      onPickMonth={onPickMonth}
                    />
                  )}
                </section>
                <section style={card}>
                  <SectionHeading
                    title="Elevation profiles"
                    subtitle="Every activity's climb against distance, overlaid"
                  />
                  {profiles.status !== "ready" ? (
                    <p style={statusText}>
                      {profiles.status === "loading"
                        ? "Loading elevation profiles…"
                        : "Couldn't load elevation profiles."}
                    </p>
                  ) : chart && filter ? (
                    <ElevationProfiles chart={chart} types={typeOrder} />
                  ) : (
                    <p style={statusText}>No visible activity has an elevation profile.</p>
                  )}
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

const statusText: CSSProperties = {
  margin: 0,
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-muted)",
};

const emptyText: CSSProperties = {
  marginTop: 18,
  fontSize: 13,
  color: "var(--text-muted)",
};
