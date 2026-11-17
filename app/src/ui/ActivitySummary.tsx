// One activity in numbers, the same wherever it shows (the map panel, the Activities
// page's preview): the stats in one divided row, then its charts, each reading its own
// value at the shared cursor, the heart-rate line in its zones' colors (how hard it
// was) with the average and max in its title. The charts stack in a narrow column and sit side by side where there
// is room (minColumn). The cursor is the caller's, so the map can draw it on the route.
// The map panel shows it all in one column (ActivitySummary); the preview puts the
// stats beside its track and the charts under both (ActivityStats, ActivityChartsBlock).

import { memo, useMemo, type ReactNode } from "react";
import { Reading, StatList } from "./StatsSection";
import { ActivityCharts, detailMessage } from "./ActivityCharts";
import { FS } from "./theme";
import { activityCards, type StatCard } from "../stats";
import { buildProfile, chartKinds, maxAltitude } from "../profile";
import { formatMeters } from "../format";
import type { DetailState } from "../detail";
import type { ActivityRecord } from "../types";

/** Height the charts take side by side (caption, title, plot, axis), held while they load. */
const LOADING_H = 120;
/** Between the summary's sections. */
const SECTION_GAP = 18;

interface StatsProps {
  activity: ActivityRecord;
  /** Stats after the four (the preview's time span, which the panel's subtitle carries). */
  extraCards?: StatCard[];
  /** The stats in this many columns (a narrow column) rather than one row. */
  columns?: number;
  /** Under the stats (the panel's place and same-route rows). */
  children?: ReactNode;
}

const NO_CARDS: StatCard[] = [];

/**
 * The stats row and anything under it. Memoized: it sits beside the charts, which
 * re-render on every cursor move, and its props don't change with the cursor (hence the
 * one empty default, not a new [] per render).
 */
export const ActivityStats = memo(function ActivityStats({ activity: a, extraCards = NO_CARDS, columns, children }: StatsProps) {
  // Only the stats with a value: an indoor session has no distance.
  const cards = useMemo(() => [...activityCards(a).filter((c) => c.value !== "—"), ...extraCards], [a, extraCards]);
  return (
    <>
      {cards.length > 0 && <StatList cards={cards} columns={columns} pad={12} />}
      {children}
    </>
  );
});

interface ChartsProps {
  activity: ActivityRecord;
  detail: DetailState;
  cursor: number | null;
  onCursor: (i: number | null) => void;
  /** The narrowest a chart may be beside another; without it they stack. */
  minColumn?: number;
  /** Whether hovering the route on a map also moves the cursor, for the hint. */
  routeLinked?: boolean;
  /** The heart-rate zones' lower bounds, to color the heart-rate line by zone. */
  zoneLimits?: readonly number[];
}

/**
 * The activity's charts, the high point in the elevation title and average and max in
 * the heart rate's; while the samples load or if they
 * fail, a line saying so. An activity without samples has no charts and no line.
 */
export function ActivityChartsBlock({
  activity: a,
  detail: state,
  cursor,
  onCursor,
  minColumn,
  routeLinked = true,
  zoneLimits,
}: ChartsProps) {
  const detail = state.status === "ready" ? state.detail : null;
  const profile = useMemo(() => (detail ? buildProfile(detail, a.type) : null), [detail, a.type]);
  const top = detail ? maxAltitude(detail) : undefined;
  const message = state.status === "loading" || state.status === "error" ? detailMessage(state, false) : null;
  if (detail && profile) {
    return (
      <ActivityCharts
        detail={detail}
        profile={profile}
        cursor={cursor}
        onCursor={onCursor}
        kinds={chartKinds(profile, a.type)}
        routeLinked={routeLinked}
        minColumn={minColumn}
        zoneLimits={zoneLimits}
        rests={{
          elevation: top !== undefined && <Reading label="High point" value={formatMeters(top)} unit="m" />,
          hr: a.avg_hr !== undefined && (
            <span>
              <Reading label="avg" value={String(Math.round(a.avg_hr))} unit={a.max_hr === undefined ? "bpm" : undefined} />
              {a.max_hr !== undefined && (
                <>
                  <span style={{ color: "var(--text-faint)" }}>{"\u00a0·\u00a0"}</span>
                  <Reading label="max" value={String(Math.round(a.max_hr))} unit="bpm" />
                </>
              )}
            </span>
          ),
        }}
      />
    );
  }
  return message ? (
    <div style={{ minHeight: state.status === "loading" ? LOADING_H : undefined }}>
      <p style={{ margin: 0, fontSize: FS.sm, color: "var(--text-muted)" }}>{message}</p>
    </div>
  ) : null;
}

/** Both, in one column: the map panel's body. */
export function ActivitySummary({
  activity,
  detail,
  cursor,
  onCursor,
  children,
  zoneLimits,
}: Omit<StatsProps, "extraCards" | "columns"> & Omit<ChartsProps, "minColumn" | "routeLinked">) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SECTION_GAP, minWidth: 0 }}>
      <ActivityStats activity={activity}>
        {children}
      </ActivityStats>
      <ActivityChartsBlock activity={activity} detail={detail} cursor={cursor} onCursor={onCursor} zoneLimits={zoneLimits} />
    </div>
  );
}
