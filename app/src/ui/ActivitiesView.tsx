// Activities page: every visible activity in one list, with a search box and sortable
// columns, on the same surface and beside the same filters panel as analytics. The
// search narrows the visible activities further (activitySearch.ts); it never changes
// the Activity filter itself, so the map and analytics stay as they were. A row opens a
// quick preview under it (ActivityPreview), and from there the activity on the map.

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { EmptyPage } from "./AnalyticsView";
import { ActivityPreview } from "./ActivityPreview";
import { ChevronIcon, CloseIcon, SearchIcon } from "./icons";
import { card, FS, MONO, R, secondaryButton } from "./theme";
import { SIDE_PANEL_CLEARANCE } from "./layout";
import { isVisible, type ActivityFilter } from "../activityFilter";
import {
  activityMatcher,
  highlightRanges,
  searchIndex,
  nextSort,
  sortActivities,
  type SearchNames,
  type Sort,
  type SortKey,
} from "../activitySearch";
import { formatDate, formatDuration, formatKm, formatMeters, formatMonthShort, typeLabel } from "../format";
import { emptyNotice } from "../places";
import { typeColor } from "../colors";
import type { ActivityRecord, Theme } from "../types";

interface Props {
  /** null until the data loads. */
  filter: ActivityFilter | null;
  /** The visible activities, as App hands them to the other pages. */
  visible: ActivityRecord[];
  /** Place and same-route names, to show and to search by. */
  names: SearchNames;
  /** The routes the map can draw, as [lng, lat] points by activity id. */
  routes: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  query: string;
  onQueryChange: (query: string) => void;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  /** A preview's "Show on map": show that activity on the map. */
  onOpen: (id: string) => void;
  /** Widen the filter just enough to show these (matches the filter hides). */
  onReveal: (activities: ActivityRecord[]) => void;
  sidePanelExpanded: boolean;
  mobile?: boolean;
  onResetFilter?: () => void;
  onClearPlace?: () => void;
  theme?: Theme;
}

/** Gap between the docked filters panel and the content column, as on analytics. */
const GUTTER = 24;

/** The list's columns: date, activity, distance, moving time, climb, then the chevron. */
const GRID = "96px minmax(0, 1fr) 84px 92px 72px 16px";
/** On a phone: activity, distance and the chevron; the date moves under the name. */
const GRID_COMPACT = "minmax(0, 1fr) auto 16px";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "date", label: "Date", numeric: false },
  { key: "name", label: "Activity", numeric: false },
  { key: "distance", label: "Distance", numeric: true },
  { key: "time", label: "Moving time", numeric: true },
  { key: "elevation", label: "Climb", numeric: true },
];

/** The phone's sort menu: one entry per useful column and direction. */
const SORT_OPTIONS: { value: string; label: string; sort: Sort }[] = [
  { value: "date-desc", label: "Newest first", sort: { key: "date", dir: "desc" } },
  { value: "date-asc", label: "Oldest first", sort: { key: "date", dir: "asc" } },
  { value: "name-asc", label: "Name, A–Z", sort: { key: "name", dir: "asc" } },
  { value: "distance-desc", label: "Farthest", sort: { key: "distance", dir: "desc" } },
  { value: "time-desc", label: "Longest", sort: { key: "time", dir: "desc" } },
  { value: "elevation-desc", label: "Most climbing", sort: { key: "elevation", dir: "desc" } },
];

export function ActivitiesView({
  filter,
  visible,
  names,
  routes,
  query,
  onQueryChange,
  sort,
  onSortChange,
  onOpen,
  onReveal,
  sidePanelExpanded,
  mobile = false,
  onResetFilter,
  onClearPlace,
  theme = "dark",
}: Props) {
  const left = sidePanelExpanded && !mobile ? SIDE_PANEL_CLEARANCE + GUTTER : GUTTER;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Built once per data load (the filter keeps its activities array as it changes).
  const index = useMemo(() => searchIndex(filter?.activities ?? [], names), [filter?.activities, names]);
  // The box shows every letter at once; the list follows the deferred query, so React
  // renders it in the background and drops a render a newer letter makes stale. Typing
  // never waits on the list (the first letter can re-highlight ~450 rows).
  const shownQuery = useDeferredValue(query);
  const match = useMemo(() => activityMatcher(shownQuery, index), [shownQuery, index]);
  const rows = useMemo(() => sortActivities(visible.filter(match), sort), [visible, match, sort]);
  // Matches the filter hides: offered as a way to widen it, never shown unasked.
  const hidden = useMemo(
    () => (filter && shownQuery.trim() ? filter.activities.filter((a) => match(a) && !isVisible(filter, a)) : []),
    [filter, shownQuery, match],
  );
  const searching = shownQuery.trim() !== "";

  // The one activity previewed under its row, if any.
  const [openId, setOpenId] = useState<string | null>(null);
  // Stable, so a toggle re-renders only the rows whose `open` changed (ActivityRow is
  // memoized): re-rendering all ~450 rows on every click was what made opening laggy.
  const toggle = useCallback((id: string) => setOpenId((open) => (open === id ? null : id)), []);
  // Bring a newly opened preview into view: a row near the bottom would open off screen.
  useEffect(() => {
    if (openId) document.getElementById(previewId(openId))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openId]);

  // "/" jumps to the search box from anywhere on the page, as on most sites with one.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rowButtons = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-row]") ?? [])];

  // Esc clears the box first (and keeps App from backing out of anything else); arrow
  // down steps into the results.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      onQueryChange("");
    } else if (e.key === "ArrowDown") {
      const first = rowButtons()[0];
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  // Arrow keys move between rows; up from the first goes back to the search box. Esc
  // closes an open preview (before App backs out of anything else).
  const onListKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key === "Escape" && openId) {
      e.preventDefault();
      const id = openId;
      setOpenId(null);
      rowButtons()
        .find((b) => b.dataset.row === id)
        ?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = rowButtons();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    e.preventDefault();
    if (e.key === "ArrowDown") buttons[Math.min(i + 1, buttons.length - 1)].focus();
    else if (i === 0) inputRef.current?.focus();
    else buttons[i - 1].focus();
  };

  const total = visible.length;
  const lede = !filter
    ? null
    : searching
      ? `${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${plural(total)} match`
      : `${total.toLocaleString("en-US")} ${plural(total)} from ${formatMonthShort(filter.fromMonth)} to ${formatMonthShort(filter.toMonth)}`;

  return (
    <main
      aria-label="Activities"
      className="analytics activities"
      style={{ ["--analytics-left" as string]: `${left}px` }}
    >
      <div className="analytics__column">
        <h1 className="analytics__intro" style={heading}>Activities</h1>
        {filter && (
          <>
            <p className="analytics__intro" style={ledeStyle} aria-live="polite">
              {lede}
            </p>
            {total === 0 ? (
              <EmptyPage notice={emptyNotice(filter, names.places)} onClearPlace={onClearPlace} onResetFilter={onResetFilter} />
            ) : (
              <>
                <div className="activities__toolbar">
                  <label style={searchBox} className="activities__search">
                    <span style={{ display: "flex", color: "var(--text-muted)" }}>
                      <SearchIcon />
                    </span>
                    <input
                      ref={inputRef}
                      type="search"
                      value={query}
                      onChange={(e) => onQueryChange(e.target.value)}
                      onKeyDown={onSearchKey}
                      placeholder="Search by name, place, type or date"
                      aria-label="Search activities"
                      aria-controls="activity-list"
                      autoComplete="off"
                      spellCheck={false}
                      style={searchInput}
                    />
                    {query ? (
                      <button
                        type="button"
                        className="ctl"
                        onClick={() => {
                          onQueryChange("");
                          inputRef.current?.focus();
                        }}
                        aria-label="Clear search"
                        title="Clear search"
                        style={clearButton}
                      >
                        <CloseIcon size={14} />
                      </button>
                    ) : (
                      !mobile && (
                        <kbd aria-hidden="true" style={kbd}>
                          /
                        </kbd>
                      )
                    )}
                  </label>
                  {mobile && (
                    <select
                      aria-label="Sort activities"
                      value={`${sort.key}-${sort.dir}`}
                      onChange={(e) => {
                        const opt = SORT_OPTIONS.find((o) => o.value === e.target.value);
                        if (opt) onSortChange(opt.sort);
                      }}
                      style={sortSelect}
                    >
                      {/* A column sort the menu doesn't list still needs an entry to show. */}
                      {!SORT_OPTIONS.some((o) => o.value === `${sort.key}-${sort.dir}`) && (
                        <option value={`${sort.key}-${sort.dir}`}>Sorted</option>
                      )}
                      {SORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <section style={{ ...card, padding: 0, overflow: "hidden" }} aria-label="Activity list">
                  {!mobile && (
                    <div className="activities__head" role="group" aria-label="Sort by" style={{ gridTemplateColumns: GRID }}>
                      {COLUMNS.map((c) => {
                        const on = sort.key === c.key;
                        return (
                          <button
                            key={c.key}
                            type="button"
                            className="ctl"
                            onClick={() => onSortChange(nextSort(sort, c.key))}
                            aria-pressed={on}
                            title={`Sort by ${c.label.toLowerCase()}`}
                            style={headButton(on, c.numeric)}
                          >
                            {c.label}
                            <span aria-hidden="true" style={{ width: 8, opacity: on ? 1 : 0 }}>
                              {sort.dir === "asc" ? "↑" : "↓"}
                            </span>
                            {on && <span className="sr-only">{sort.dir === "asc" ? ", ascending" : ", descending"}</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {rows.length > 0 ? (
                    <ol id="activity-list" ref={listRef} onKeyDown={onListKey} style={list}>
                      {rows.map((a) => {
                        const open = a.id === openId;
                        const coords = routes.get(a.id);
                        return (
                          <li key={a.id}>
                            <ActivityRow
                              activity={a}
                              query={shownQuery}
                              names={names}
                              onMap={coords !== undefined}
                              open={open}
                              onToggle={toggle}
                              mobile={mobile}
                              theme={theme}
                            />
                            {open && (
                              <ActivityPreview
                                id={previewId(a.id)}
                                activity={a}
                                coords={coords}
                                onShowOnMap={coords ? () => onOpen(a.id) : undefined}
                                mobile={mobile}
                                theme={theme}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <div style={{ padding: 20 }}>
                      <p style={{ margin: "0 0 12px", fontSize: FS.md, color: "var(--text-soft)" }}>
                        No visible activity matches “{shownQuery.trim()}”.
                      </p>
                      <button
                        type="button"
                        className="ctl"
                        style={secondaryButton}
                        onClick={() => {
                          onQueryChange("");
                          inputRef.current?.focus();
                        }}
                      >
                        Clear search
                      </button>
                    </div>
                  )}
                </section>

                {hidden.length > 0 && (
                  <p style={outsideNote}>
                    {hidden.length.toLocaleString("en-US")} more {plural(hidden.length)} outside the filter{" "}
                    {hidden.length === 1 ? "matches" : "match"}.{" "}
                    <button type="button" className="link-button" onClick={() => onReveal(hidden)}>
                      Show {hidden.length === 1 ? "it" : "them"}
                    </button>
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

const plural = (n: number) => (n === 1 ? "activity" : "activities");
const previewId = (id: string) => `preview-${id}`;

/**
 * One activity: a button that opens and closes its preview. Memoized: its props stay the
 * same unless this row's activity, the query, or its open state change.
 */
const ActivityRow = memo(function ActivityRow({
  activity: a,
  query,
  names,
  onMap,
  open,
  onToggle,
  mobile,
  theme,
}: {
  activity: ActivityRecord;
  query: string;
  names: SearchNames;
  onMap: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  mobile: boolean;
  theme: Theme;
}) {
  const place = a.place !== undefined ? names.places.get(a.place)?.name : undefined;
  const route = a.route !== undefined ? names.routes.get(a.route) : undefined;
  const date = formatDate(a.ts);
  const meta: ReactNode[] = [<Highlight key="type" text={typeLabel(a.type)} query={query} />];
  if (mobile) meta.push(<Highlight key="date" text={date} query={query} />);
  if (place) meta.push(<Highlight key="place" text={place} query={query} />);
  else if (route) meta.push(<Highlight key="route" text={route} query={query} />);
  if (!onMap) meta.push(<span key="noroute" style={{ color: "var(--text-faint)" }}>No route</span>);

  const columns = mobile ? GRID_COMPACT : GRID;
  const body = (
    <>
      {!mobile && <span style={dateCell}>{date}</span>}
      <span style={{ minWidth: 0 }}>
        <span style={nameLine}>
          <Highlight text={a.name || "Untitled"} query={query} />
        </span>
        <span style={metaLine}>
          <span aria-hidden="true" style={{ ...dot, background: typeColor(a.type, theme) }} />
          {meta.map((m, i) => (
            <span key={i} style={{ whiteSpace: "nowrap" }}>
              {i > 0 && <span style={{ color: "var(--text-faint)", margin: "0 6px" }}>·</span>}
              {m}
            </span>
          ))}
        </span>
      </span>
      <Num value={formatKm(a.distance)} unit={a.distance !== undefined ? "km" : undefined} />
      {!mobile && <Num value={formatDuration(a.moving_time)} />}
      {!mobile && <Num value={formatMeters(a.elevation_gain)} unit={a.elevation_gain !== undefined ? "m" : undefined} />}
      <span style={{ display: "flex", color: open ? "var(--accent-text)" : "var(--text-faint)" }} aria-hidden="true">
        <ChevronIcon dir={open ? "up" : "down"} size={14} />
      </span>
    </>
  );

  return (
    <button
      type="button"
      data-row={a.id}
      className={open ? "activities__row" : "ctl activities__row"}
      onClick={() => onToggle(a.id)}
      aria-expanded={open}
      aria-controls={open ? previewId(a.id) : undefined}
      style={{
        ...rowStyle,
        gridTemplateColumns: columns,
        background: open ? "var(--accent-tint-weak)" : "transparent",
      }}
    >
      {body}
    </button>
  );
});

function Num({ value, unit }: { value: string; unit?: string }) {
  return (
    <span style={numCell}>
      {value}
      {unit && <span style={{ color: "var(--text-muted)", marginLeft: 3, fontSize: FS.xs }}>{unit}</span>}
    </span>
  );
}

/** `text` with the query's words marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={s} style={mark}>
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

const heading: CSSProperties = {
  margin: 0,
  fontSize: FS["2xl"],
  fontWeight: 700,
  letterSpacing: "-.01em",
  color: "var(--text-strong)",
};

const ledeStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: FS.md,
  color: "var(--text-muted)",
};

const searchBox: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: 44,
  boxSizing: "border-box",
  padding: "0 8px 0 14px",
  borderRadius: R.md,
  background: "var(--bg-raised)",
  border: "1px solid var(--panel-border)",
  cursor: "text",
};

const searchInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: "100%",
  border: 0,
  outline: "none",
  background: "transparent",
  color: "var(--text-strong)",
  font: "inherit",
  fontSize: FS.md + 1,
};

const clearButton: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: R.sm,
  border: 0,
  background: "transparent",
  color: "var(--text-muted)",
};

const kbd: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.xs,
  color: "var(--text-muted)",
  border: "1px solid var(--control-border)",
  borderRadius: 5,
  padding: "1px 6px",
  marginRight: 4,
};

const sortSelect: CSSProperties = {
  height: 44,
  boxSizing: "border-box",
  padding: "0 10px",
  borderRadius: R.md,
  background: "var(--bg-raised)",
  border: "1px solid var(--panel-border)",
  color: "var(--text)",
  font: "inherit",
  fontSize: FS.sm + 0.5,
};

function headButton(on: boolean, numeric: boolean): CSSProperties {
  return {
    appearance: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: numeric ? "flex-end" : "flex-start",
    gap: 4,
    height: 28,
    padding: "0 6px",
    margin: "0 -6px",
    border: 0,
    borderRadius: 6,
    background: "transparent",
    color: on ? "var(--text-strong)" : "var(--text-muted)",
    font: "inherit",
    fontSize: FS.xs + 0.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

const list: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

const rowStyle: CSSProperties = {
  appearance: "none",
  width: "100%",
  boxSizing: "border-box",
  border: 0,
  background: "transparent",
  color: "var(--text)",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const dateCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.sm,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
};

const nameLine: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: FS.md,
  fontWeight: 600,
  color: "var(--text-strong)",
};

const metaLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  rowGap: 2,
  marginTop: 3,
  fontSize: FS.sm,
  color: "var(--text-muted)",
};

const dot: CSSProperties = {
  width: 8,
  height: 8,
  flex: "0 0 auto",
  borderRadius: "50%",
  marginRight: 7,
};

const numCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.sm + 0.5,
  textAlign: "right",
  whiteSpace: "nowrap",
  color: "var(--text)",
};

const mark: CSSProperties = {
  background: "var(--accent-tint)",
  color: "var(--accent-text)",
  borderRadius: 3,
  padding: "0 1px",
};

const outsideNote: CSSProperties = {
  margin: "12px 4px 0",
  fontSize: FS.sm + 0.5,
  color: "var(--text-muted)",
};
