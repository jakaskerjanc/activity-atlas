// Activities page: every visible activity in one list, with a search box and sortable
// columns, on the same surface and beside the same filters panel as analytics. The
// search narrows the visible activities further (activitySearch.ts); it never changes
// the Activity filter itself, so the map and analytics stay as they were. A row opens a
// quick preview under it (ActivityPreview), and from there the activity on the map.
// Each row shows its route small beside the name (trackSketch.ts: thumbnailPath). The
// Group choice splits the list by week or month under headers with subtotals
// (activityGroups.ts); headers and gap lines are items of the same virtualized list.
// Only the rows near the screen are drawn (TanStack Virtual): at ten times today's
// activities, drawing every row was ~120,000 elements and a five-second task.

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { EmptyPage } from "./AnalyticsView";
import { ActivityPreview } from "./ActivityPreview";
import { ChevronIcon, CloseIcon, SearchIcon } from "./icons";
import { card, FS, MONO, pillStyle, R, secondaryButton } from "./theme";
import { SIDE_PANEL_CLEARANCE } from "./layout";
import { nextRowIndex, withPinned } from "./listWindow";
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
import { THUMB_SIZE, thumbnailPath } from "../trackSketch";
import { gapLabel, groupTitle, listItems, totalsLabel, type Grouping, type ListItem } from "../activityGroups";
import type { ActivityRecord, Theme } from "../types";

interface Props {
  /** null until the data loads. */
  filter: ActivityFilter | null;
  /** The visible activities, as App hands them to the other pages. */
  visible: ActivityRecord[];
  /** Place and same-route names, to show and to search by. */
  names: SearchNames;
  /**
   * The routes the map can draw, as [lng, lat] points by activity id. null while they
   * load (the list doesn't wait for them) or when they failed to.
   */
  routes: ReadonlyMap<string, readonly (readonly [number, number])[]> | null;
  query: string;
  onQueryChange: (query: string) => void;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  grouping: Grouping;
  onGroupingChange: (grouping: Grouping) => void;
  /** A preview's "Show on map": show that activity on the map. */
  onOpen: (id: string) => void;
  /** Widen the filter just enough to show these (matches the filter hides). */
  onReveal: (activities: ActivityRecord[]) => void;
  sidePanelExpanded: boolean;
  mobile?: boolean;
  onResetFilter?: () => void;
  onClearPlace?: () => void;
  theme?: Theme;
  /** The heart-rate zones' lower bounds, for the previews' zone ranges. */
  zoneLimits?: readonly number[];
}

/** Gap between the docked filters panel and the content column, as on analytics. */
const GUTTER = 24;

// The list's columns are in index.css (.activities__head, .activities__row): date,
// activity, distance, moving time, climb, then the chevron; on a phone (data-compact)
// activity, distance and the chevron, with the date under the name. The rows' fixed
// look is there too: set inline, every style property cost a write per row (~450).

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "date", label: "Date", numeric: false },
  { key: "name", label: "Activity", numeric: false },
  { key: "distance", label: "Distance", numeric: true },
  { key: "time", label: "Moving time", numeric: true },
  { key: "elevation", label: "Climb", numeric: true },
];

/**
 * A closed row's height: the name line, the meta line and the padding, the same in the
 * compact rows, whose date joins the meta line. Rows are measured once drawn, so a
 * compact row whose meta line wraps (72px) or an open preview takes its real height.
 */
const ROW_ESTIMATE = 55;
/** A group header's and a gap line's heights, likewise measured once drawn. */
const HEADER_ESTIMATE = 45;
const GAP_ESTIMATE = 30;
/** Rows drawn past each edge of the screen, so a quick scroll doesn't show a gap. */
const OVERSCAN = 8;
/**
 * The window's height before the page is laid out: what the server-rendered markup
 * (and the tests) draw from. About a laptop screen's worth of rows.
 */
const INITIAL_RECT = { width: 0, height: 900 };

/** The Group choices: pills on a wide screen, a menu on a phone. */
const GROUPINGS: { value: Grouping; label: string; menu: string }[] = [
  { value: "none", label: "None", menu: "No groups" },
  { value: "week", label: "Week", menu: "By week" },
  { value: "month", label: "Month", menu: "By month" },
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
  grouping,
  onGroupingChange,
  onOpen,
  onReveal,
  sidePanelExpanded,
  mobile = false,
  onResetFilter,
  onClearPlace,
  theme = "dark",
  zoneLimits,
}: Props) {
  const left = sidePanelExpanded && !mobile ? SIDE_PANEL_CLEARANCE + GUTTER : GUTTER;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const ledeRef = useRef<HTMLParagraphElement>(null);

  // Built once per data load (the filter keeps its activities array as it changes).
  const index = useMemo(() => searchIndex(filter?.activities ?? [], names), [filter?.activities, names]);
  // The box shows every letter at once; the list follows the deferred query, so React
  // renders it in the background and drops a render a newer letter makes stale. Typing
  // never waits on the list (the first letter can re-highlight ~450 rows).
  const shownQuery = useDeferredValue(query);
  const match = useMemo(() => activityMatcher(shownQuery, index), [shownQuery, index]);
  const sorted = useMemo(() => sortActivities(visible.filter(match), sort), [visible, match, sort]);
  // The list's items (rows, and headers and gap lines when grouped); the rows alone, in
  // the order shown; and each row's item index. The arrow keys and aria-posinset count
  // rows, the virtualizer counts items.
  const { items, rows, itemOf } = useMemo(() => {
    const items = listItems(sorted, grouping, sort);
    const rows: ActivityRecord[] = [];
    const itemOf: number[] = [];
    items.forEach((it, i) => {
      if (it.kind !== "row") return;
      rows.push(it.activity);
      itemOf.push(i);
    });
    return { items, rows, itemOf };
  }, [sorted, grouping, sort]);
  // Matches the filter hides: offered as a way to widen it, never shown unasked.
  const hidden = useMemo(
    () => (filter && shownQuery.trim() ? filter.activities.filter((a) => match(a) && !isVisible(filter, a)) : []),
    [filter, shownQuery, match],
  );
  const searching = shownQuery.trim() !== "";
  const indexOf = useMemo(() => new Map(rows.map((a, i) => [a.id, i])), [rows]);

  // The one activity previewed under its row, if any.
  const [openId, setOpenId] = useState<string | null>(null);
  // Stable, so a toggle re-renders only the rows whose `open` changed (ActivityRow is
  // memoized): re-rendering all ~450 rows on every click was what made opening laggy.
  const toggle = useCallback((id: string) => setOpenId((open) => (open === id ? null : id)), []);
  // Bring a newly opened preview into view: a row near the bottom would open off screen.
  useEffect(() => {
    if (openId) document.getElementById(previewId(openId))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [openId]);

  // The row holding keyboard focus. It stays drawn while scrolled away (pinned, below),
  // so the arrow keys still move from it and focus never drops to the page.
  const [focusId, setFocusId] = useState<string | null>(null);
  const onListFocus = (e: FocusEvent<HTMLOListElement>) => {
    const id = (e.target as HTMLElement).dataset.row;
    if (id !== undefined) setFocusId(id);
  };
  const onListBlur = (e: FocusEvent<HTMLOListElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusId(null);
  };

  // Where the list starts inside the page's scroll area (<main>): the title, the lede,
  // the search bar and the column head are above it. Measured when the list appears and
  // when the page or the lede (which can wrap) changes size, never per render: each
  // measurement forces a layout, and the list re-renders on every scroll step.
  const [scrollMargin, setScrollMargin] = useState(0);
  const hasList = rows.length > 0;
  useLayoutEffect(() => {
    const main = mainRef.current;
    const list = listRef.current;
    if (!main || !list) return;
    const measure = () => {
      const top = list.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      setScrollMargin((m) => (Math.abs(m - top) < 0.5 ? m : top));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    if (ledeRef.current) ro.observe(ledeRef.current);
    return () => ro.disconnect();
  }, [hasList, mobile]);

  // The window: the items on screen, a few either side, and the focused and open rows.
  const itemIndex = (id: string | null) => {
    const row = id !== null ? indexOf.get(id) : undefined;
    return row !== undefined ? itemOf[row] : undefined;
  };
  const focusIndex = itemIndex(focusId);
  const openIndex = itemIndex(openId);
  const rangeExtractor = useCallback(
    (range: Range) => withPinned(defaultRangeExtractor(range), [focusIndex, openIndex], range.count),
    [focusIndex, openIndex],
  );
  const getItemKey = useCallback((i: number) => itemKey(items[i]), [items]);
  const estimateSize = useCallback(
    (i: number) => (items[i].kind === "row" ? ROW_ESTIMATE : items[i].kind === "header" ? HEADER_ESTIMATE : GAP_ESTIMATE),
    [items],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => mainRef.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
    rangeExtractor,
    scrollMargin,
    initialRect: INITIAL_RECT,
  });

  const rowButton = (id: string) =>
    [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-row]") ?? [])].find((b) => b.dataset.row === id);

  // Focus row `i`. A row that isn't drawn is scrolled to first, then focused once it is.
  const focusRow = (i: number) => {
    const id = rows[i]?.id;
    if (id === undefined) return;
    const now = rowButton(id);
    if (now) {
      now.focus();
      return;
    }
    virtualizer.scrollToIndex(itemOf[i], { align: "center" });
    let tries = 0;
    const retry = () => {
      const b = rowButton(id);
      if (b) b.focus();
      else if (++tries < 10) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  };

  // "/" jumps to the search box from anywhere on the page, as on most sites with one.
  // Ctrl+F (Cmd+F) does too: the browser's find sees only the rows drawn, the search box
  // every row. Pressed again in the box, it is left to the browser's find.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey) return;
      const input = inputRef.current;
      if (!input) return;
      if (e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (document.activeElement === input) return;
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Esc clears the box first (and keeps App from backing out of anything else); arrow
  // down steps into the results.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      onQueryChange("");
    } else if (e.key === "ArrowDown" && rows.length > 0) {
      e.preventDefault();
      focusRow(0);
    }
  };
  // Arrow keys move between rows; up from the first goes back to the search box. Esc
  // closes an open preview (before App backs out of anything else).
  const onListKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key === "Escape" && openId) {
      e.preventDefault();
      const id = openId;
      setOpenId(null);
      rowButton(id)?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const id = (document.activeElement as HTMLElement | null)?.dataset.row;
    const i = id !== undefined ? indexOf.get(id) : undefined;
    if (i === undefined) return;
    e.preventDefault();
    const next = nextRowIndex(i, e.key, rows.length);
    if (next === -1) inputRef.current?.focus();
    else focusRow(next);
  };

  const total = visible.length;
  const lede = !filter
    ? null
    : searching
      ? `${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${plural(total)} match`
      : `${total.toLocaleString("en-US")} ${plural(total)} from ${formatMonthShort(filter.fromMonth)} to ${formatMonthShort(filter.toMonth)}`;

  return (
    <main
      ref={mainRef}
      aria-label="Activities"
      className="analytics activities"
      style={{ ["--analytics-left" as string]: `${left}px` }}
    >
      <div className="analytics__column">
        <h1 className="analytics__intro" style={heading}>Activities</h1>
        {filter && (
          <>
            <p ref={ledeRef} className="analytics__intro" style={ledeStyle} aria-live="polite">
              {lede}
            </p>
            {total === 0 ? (
              <EmptyPage notice={emptyNotice(filter, names.places)} onClearPlace={onClearPlace} onResetFilter={onResetFilter} />
            ) : (
              <>
                {/* On a phone the search box takes the first line, the sort and group menus the second. */}
                <div className="activities__toolbar" data-compact={mobile ? "" : undefined}>
                  <label style={mobile ? { ...searchBox, flexBasis: "100%" } : searchBox} className="activities__search">
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
                  {mobile ? (
                    <select
                      aria-label="Group activities"
                      value={grouping}
                      onChange={(e) => onGroupingChange(e.target.value as Grouping)}
                      style={sortSelect}
                    >
                      {GROUPINGS.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.menu}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div role="group" aria-label="Group activities" className="activities__grouping">
                      <span aria-hidden="true">Group</span>
                      {GROUPINGS.map((g) => (
                        <button
                          key={g.value}
                          type="button"
                          className={grouping === g.value ? undefined : "ctl"}
                          aria-pressed={grouping === g.value}
                          onClick={() => onGroupingChange(g.value)}
                          style={pillStyle(grouping === g.value)}
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <section style={{ ...card, padding: 0, overflow: "hidden" }} aria-label="Activity list">
                  {!mobile && (
                    <div className="activities__head" role="group" aria-label="Sort by">
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
                    <ol
                      id="activity-list"
                      className="activities__list"
                      data-compact={mobile ? "" : undefined}
                      ref={listRef}
                      onKeyDown={onListKey}
                      onFocus={onListFocus}
                      onBlur={onListBlur}
                      style={{ height: virtualizer.getTotalSize() }}
                    >
                      {virtualizer.getVirtualItems().map((item) => {
                        const it = items[item.index];
                        const place = { transform: `translateY(${item.start - scrollMargin}px)` };
                        if (it.kind !== "row") {
                          return (
                            <li
                              key={item.key}
                              ref={virtualizer.measureElement}
                              data-index={item.index}
                              className="activities__item"
                              style={place}
                            >
                              {it.kind === "header" ? (
                                <div className="activities__group">
                                  <h2 className="activities__group-title">{groupTitle(it)}</h2>
                                  <span className="activities__group-totals">{totalsLabel(it.totals)}</span>
                                </div>
                              ) : (
                                <div className="activities__gap">{gapLabel(it, searching)}</div>
                              )}
                            </li>
                          );
                        }
                        const a = it.activity;
                        const open = a.id === openId;
                        const coords = routes?.get(a.id);
                        return (
                          <li
                            key={a.id}
                            ref={virtualizer.measureElement}
                            data-index={item.index}
                            aria-setsize={rows.length}
                            aria-posinset={it.row + 1}
                            className="activities__item"
                            style={place}
                          >
                            <ActivityRow
                              activity={a}
                              query={shownQuery}
                              names={names}
                              route={coords}
                              onMap={coords !== undefined || (routes === null && a.channels.includes("gps"))}
                              open={open}
                              onToggle={toggle}
                              mobile={mobile}
                              theme={theme}
                              rowOf={filter?.rowOf}
                            />
                            {open && (
                              <ActivityPreview
                                id={previewId(a.id)}
                                activity={a}
                                coords={coords}
                                onShowOnMap={coords ? () => onOpen(a.id) : undefined}
                                mobile={mobile}
                                theme={theme}
                                zoneLimits={zoneLimits}
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
const itemKey = (it: ListItem) => (it.kind === "row" ? it.activity.id : `${it.kind}:${it.key}`);

/**
 * One activity: a button that opens and closes its preview. Memoized: its props stay the
 * same unless this row's activity, the query, or its open state change.
 */
const ActivityRow = memo(function ActivityRow({
  activity: a,
  query,
  names,
  route: coords,
  onMap,
  open,
  onToggle,
  mobile,
  theme,
  rowOf,
}: {
  activity: ActivityRecord;
  query: string;
  names: SearchNames;
  /** The route, for the thumbnail; undefined while the routes load or when it has none. */
  route?: readonly (readonly [number, number])[];
  /** Has a route, or, while the routes load, a GPS track that will make one. */
  onMap: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  mobile: boolean;
  theme: Theme;
  /** The filter's type rows: the dot and the thumbnail wear the row's color, as on the map. */
  rowOf?: Readonly<Record<string, string>>;
}) {
  const place = a.place !== undefined ? names.places.get(a.place)?.name : undefined;
  const route = a.route !== undefined ? names.routes.get(a.route) : undefined;
  const date = formatDate(a.ts);
  const meta: ReactNode[] = [<Highlight key="type" text={typeLabel(a.type)} query={query} />];
  if (mobile) meta.push(<Highlight key="date" text={date} query={query} />);
  if (place) meta.push(<Highlight key="place" text={place} query={query} />);
  else if (route) meta.push(<Highlight key="route" text={route} query={query} />);
  if (!onMap) meta.push(<span key="noroute" className="activities__faint">No route</span>);
  const thumb = coords ? thumbnailPath(coords) : null;

  const body = (
    <>
      {!mobile && <span className="activities__date">{date}</span>}
      <span className="activities__what">
        {/* Empty without a route (or while the routes load), so the names line up. */}
        <svg className="activities__thumb" viewBox={`0 0 ${THUMB_SIZE} ${THUMB_SIZE}`} aria-hidden="true">
          {thumb && <path d={thumb} />}
        </svg>
        <span className="activities__text">
          <span className="activities__name">
            <Highlight text={a.name || "Untitled"} query={query} />
          </span>
          <span className="activities__meta">
            <span aria-hidden="true" className="activities__dot" />
            {meta.map((m, i) => (
              <span key={i} className="activities__meta-item">
                {i > 0 && <span className="activities__sep">·</span>}
                {m}
              </span>
            ))}
          </span>
        </span>
      </span>
      <Num value={formatKm(a.distance)} unit={a.distance !== undefined ? "km" : undefined} />
      {!mobile && <Num value={formatDuration(a.moving_time)} />}
      {!mobile && <Num value={formatMeters(a.elevation_gain)} unit={a.elevation_gain !== undefined ? "m" : undefined} />}
      <span className="activities__chevron" aria-hidden="true">
        <ChevronIcon dir={open ? "up" : "down"} size={14} />
      </span>
    </>
  );

  // An open row's tint and accent chevron key off aria-expanded (index.css). The one
  // style that differs per row is the type's color, read by the dot and the thumbnail.
  return (
    <button
      type="button"
      data-row={a.id}
      className={open ? "activities__row" : "ctl activities__row"}
      style={{ ["--type" as string]: typeColor(a.type, theme, rowOf) }}
      onClick={() => onToggle(a.id)}
      aria-expanded={open}
      aria-controls={open ? previewId(a.id) : undefined}
    >
      {body}
    </button>
  );
});

function Num({ value, unit }: { value: string; unit?: string }) {
  return (
    <span className="activities__num">
      {value}
      {unit && <span className="activities__unit">{unit}</span>}
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
      <mark key={s} className="activities__mark">
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

const outsideNote: CSSProperties = {
  margin: "12px 4px 0",
  fontSize: FS.sm + 0.5,
  color: "var(--text-muted)",
};
