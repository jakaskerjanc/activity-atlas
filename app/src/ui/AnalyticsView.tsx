// Analytics page: numbers about the visible activities, on a surface that covers the map.
// The side panel stays beside it with the same Activity filter. Every figure here covers
// the visible activities with or without a route; the map draws the routed ones, and its
// totals cover the same visible set, so the two pages' totals are the same numbers.

import { useMemo, type CSSProperties } from "react";
import { SectionHeading, StatGrid } from "./StatsSection";
import { ActivityCalendar } from "./ActivityCalendar";
import { Ridgeline } from "./Ridgeline";
import { ElevationProfiles } from "./ElevationProfiles";
import { CityComparisons } from "./CityComparisons";
import { ActiveHoursClocks } from "./ActiveHoursClock";
import { useRouteProfiles, type ProfilesState } from "./useRouteProfiles";
import { useSteps, type StepsState } from "./useSteps";
import type { CitiesState } from "./useCities";
import { card, FS, primaryButton } from "./theme";
import { SIDE_PANEL_CLEARANCE } from "./layout";
import {
  rangeTs,
  typesByCount,
  type ActivityFilter,
  type MonthIsolation,
} from "../activityFilter";
import { activityCalendar, consistency, consistencyCards } from "../analytics";
import { activeHoursByWeekPart } from "../activeHours";
import { stepsCalendar } from "../steps";
import { climbingRidgeline } from "../ridgeline";
import { profileChart } from "../elevationProfiles";
import { totalCards } from "../stats";
import { formatMonth, formatMonthShort } from "../format";
import type { CityComparison } from "../cityMatch";
import type { ActivityRecord, Profile, Theme } from "../types";

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
  /** The daily steps' load state; tests pass one in, the page fetches them otherwise. */
  steps?: StepsState;
  /** The city distances' load state; App owns it, since the map draws a city route too. */
  cities: CitiesState;
  /** The visible activities' distance comparisons, as App hands them to the map. */
  comparisons: CityComparison[];
  /** A comparison's "Show on map": switch to the map, showing that group's route. */
  onShowCity: (profile: Profile) => void;
  /** The phone layout: the filters overlay the page instead of docking beside it. */
  mobile?: boolean;
  /** Put the filter back to its defaults (offered when nothing matches). */
  onResetFilter?: () => void;
  theme?: Theme;
}

/** The page's sections, for the filters panel's "On this page" list. */
export const ANALYTICS_SECTIONS: { id: string; label: string }[] = [
  { id: "totals", label: "Totals" },
  { id: "consistency", label: "Consistency" },
  { id: "distance", label: "How far is that?" },
  { id: "calendar", label: "Activity calendar" },
  { id: "hours", label: "Active hours" },
  { id: "climbing", label: "Climbing by month" },
  { id: "profiles", label: "Elevation profiles" },
];

/** Gap between the docked filters panel and the content column. */
const GUTTER = 24;

export function AnalyticsView({
  filter,
  visible,
  sidePanelExpanded,
  isolation,
  onPickMonth,
  profiles: given,
  steps: givenSteps,
  cities,
  comparisons,
  onShowCity,
  mobile = false,
  onResetFilter,
  theme = "dark",
}: Props) {
  const fetched = useRouteProfiles();
  const profiles = given ?? fetched;
  const fetchedSteps = useSteps();
  const steps = givenSteps ?? fetchedSteps;
  // The column starts right of the docked filters panel and fills the rest of the page;
  // on a phone the filters overlay the page instead.
  const left = sidePanelExpanded && !mobile ? SIDE_PANEL_CLEARANCE + GUTTER : GUTTER;

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

  // The steps grid only when there is step data at all (not the demo, not a fork without
  // Garmin): a failed or empty load leaves the calendar as it was.
  const stepYears = useMemo(
    () =>
      steps.status === "ready" && steps.file.steps.length > 0 ? stepsCalendar(calendar, steps.file) : undefined,
    [steps, calendar],
  );

  const hours = useMemo(() => activeHoursByWeekPart(visible), [visible]);

  const ridgeline = useMemo(
    () => (filter ? climbingRidgeline(visible, filter.fromMonth, filter.toMonth) : null),
    [filter, visible],
  );

  // The legend's fixed type order: the filter's own (most activities first, over all data).
  const typeOrder = useMemo(() => (filter ? typesByCount(filter) : []), [filter?.activities]);

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
      className="analytics"
      style={{ ["--analytics-left" as string]: `${left}px` }}
    >
      <div className="analytics__column">
        <h1 className="analytics__intro" style={heading}>Analytics</h1>
        {filter && (
          <>
            <p className="analytics__intro" style={lede}>
              {visible.length.toLocaleString("en-US")} {visible.length === 1 ? "activity" : "activities"}
              {" from "}
              {formatMonthShort(filter.fromMonth)} to {formatMonthShort(filter.toMonth)}
            </p>
            {visible.length === 0 ? (
              <section style={{ ...card, marginTop: 16 }}>
                <SectionHeading
                  title="No activities match the filter"
                  subtitle="Switch on an activity type or widen the date range."
                />
                {onResetFilter && (
                  <button type="button" className="ctl-accent" style={primaryButton} onClick={onResetFilter}>
                    Reset filters
                  </button>
                )}
              </section>
            ) : (
              <div className="analytics__grid">
                <section id="totals" style={card}>
                  <SectionHeading title="Totals" subtitle="Distance, climbing and time" />
                  <StatGrid cards={totals} columns={2} />
                </section>
                <section id="consistency" style={card}>
                  <SectionHeading title="Consistency" subtitle="How often you get out" />
                  <StatGrid cards={cards} columns={2} />
                </section>
                <section id="distance" style={card} className="span-2">
                  <SectionHeading
                    title="How far is that?"
                    subtitle={
                      cities.status === "ready"
                        ? `Your distance as one trip from ${cities.data.origin.name}`
                        : "Your distance as one trip"
                    }
                  />
                  <CityComparisons
                    cities={cities}
                    comparisons={comparisons}
                    onShowOnMap={onShowCity}
                  />
                </section>
                <section id="calendar" style={card} className="span-2">
                  <SectionHeading
                    title="Activity calendar"
                    subtitle={stepYears ? "Moving time and steps per day" : "Moving time per day"}
                  />
                  <ActivityCalendar years={calendar} steps={stepYears} compact={mobile} />
                </section>
                <section id="hours" style={card} className="span-2">
                  <SectionHeading
                    title="Active hours"
                    subtitle="Time out in each hour of the day, local time. Each clock is scaled to its own busiest hour."
                  />
                  <ActiveHoursClocks split={hours} />
                </section>
                <section id="climbing" style={card} className="span-2">
                  <SectionHeading
                    title="Climbing by month"
                    subtitle={
                      isolation
                        ? `Showing ${formatMonth(isolation.month)} only. Click it again for ${formatMonth(isolation.fromMonth)} – ${formatMonth(isolation.toMonth)}.`
                        : "Elevation gain per day. Select a month to show only it."
                    }
                  />
                  {ridgeline && (
                    <Ridgeline
                      ridgeline={ridgeline}
                      isolatedMonth={isolation?.month ?? null}
                      onPickMonth={onPickMonth}
                      compact={mobile}
                      theme={theme}
                    />
                  )}
                </section>
                <section id="profiles" style={card} className="span-2">
                  <SectionHeading
                    title="Elevation profiles"
                    subtitle="Every activity's climb from its start, against distance"
                  />
                  {profiles.status !== "ready" ? (
                    <p style={statusText}>
                      {profiles.status === "loading"
                        ? "Loading elevation profiles…"
                        : "Couldn't load elevation profiles."}
                    </p>
                  ) : chart && filter ? (
                    <ElevationProfiles chart={chart} order={typeOrder} theme={theme} compact={mobile} />
                  ) : (
                    <p style={statusText}>No visible activity has an elevation profile.</p>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

const heading: CSSProperties = {
  margin: 0,
  fontSize: FS["2xl"],
  fontWeight: 700,
  letterSpacing: "-.01em",
  color: "var(--text-strong)",
};

const lede: CSSProperties = {
  margin: "4px 0 0",
  fontSize: FS.md,
  color: "var(--text-muted)",
};

const statusText: CSSProperties = {
  margin: 0,
  fontSize: FS.sm,
  color: "var(--text-muted)",
};
