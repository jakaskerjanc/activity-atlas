// Top-level wiring: load the GeoJSON once, own all UI state, and feed the map + the
// Activity Atlas panels. Which activities are shown is the Activity filter's call
// (activityFilter.ts); this file holds it and hands its results to the map, the
// analytics page, and the panels.

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CityRouteLine } from "./MapView";
import { Header } from "./ui/Header";
import { SidePanel } from "./ui/SidePanel";
import { InfoPanel } from "./ui/InfoPanel";
import { ReplayBar } from "./ui/ReplayBar";
import { AnalyticsView, ANALYTICS_SECTIONS } from "./ui/AnalyticsView";
import { useView } from "./ui/useView";
import { RoutePreview } from "./ui/RoutePreview";
import {
  createActivityFilter,
  activeIsolation,
  filterExpression,
  revealActivity,
  toggleMonth,
  togglePlace,
  visibleActivities,
  visibleFeatures,
  type ActivityFilter,
  type MonthIsolation,
} from "./activityFilter";
import type {
  ActivitiesFile,
  ActivityFeatureCollection,
  Place,
  PlacesFile,
  Profile,
  RoutesFile,
  Theme,
} from "./types";
import { joinActivities } from "./tracks";
import { formatDate, formatMonthShort, activityLinks, type ActivityLink } from "./format";
import { activityCards, totalCards, type StatCard } from "./stats";
import { computeDomain, type ColorMode } from "./colors";
import { buildTimeline, frameAt, totalDurationMs } from "./replay";
import { useCollapsiblePanels } from "./ui/useCollapsiblePanels";
import { useActivityDetail } from "./ui/useActivityDetail";
import { ActivityCharts, detailMessage } from "./ui/ActivityCharts";
import { GroupRows } from "./ui/GroupRows";
import { placeLine, routeTable } from "./routeGroup";
import { buildProfile } from "./profile";
import { markerPoint } from "./routeCursor";
import { gradeRoutes } from "./grade";
import { chromeInsets } from "./ui/layout";
import { FS, primaryButton, secondaryButton } from "./ui/theme";
import { MapErrorBoundary } from "./ui/MapErrorBoundary";
import { ArrowRightIcon } from "./ui/icons";
import { useRouteProfiles } from "./ui/useRouteProfiles";
import { useCities } from "./ui/useCities";
import { cityComparisons } from "./cityMatch";
import { cityCards, cityRouteSubtitle, routeTitle } from "./cityView";
import { checkPlacesFile, emptyNotice as emptyNoticeFor, PLACES_URL, placeTitle } from "./places";

// The map is almost all of the bundle (mapbox-gl), so it is its own chunk, fetched only
// once the map is wanted: a visit that opens on Analytics never pays for it until the
// user heads for the map (hovering the Map tab starts it early). On the map it waits
// for the route preview to paint, so the routes arrive before the ~520 kB that draws
// them properly instead of sharing a slow connection with it; on a fast one the wait
// is a frame or two.
let mapViewImport: Promise<typeof import("./MapView")> | null = null;
const loadMapView = () => (mapViewImport ??= import("./MapView"));
const MapView = lazy(() => loadMapView().then((m) => ({ default: m.MapView })));
// An early start on intent. A failure surfaces when the map mounts (MapErrorBoundary),
// so don't also report it here as an unhandled rejection.
const prefetchMapView = () => void loadMapView().catch(() => {});

const ROUTES_URL = `${import.meta.env.BASE_URL}data/routes.json`;
const ACTIVITIES_URL = `${import.meta.env.BASE_URL}data/activities.json`;

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

const NO_PLACES: PlacesFile = { v: 1, places: [], routes: [] };

/** places.json, checked. Optional: a failed fetch shows no places rather than no site. */
async function fetchPlaces(): Promise<PlacesFile> {
  try {
    return checkPlacesFile(await fetchJson<unknown>(PLACES_URL));
  } catch (e) {
    console.warn(`Couldn't load places: ${String(e)}; showing no places`);
    return NO_PLACES;
  }
}

// Initial theme: a saved choice wins, else follow the OS. Kept in sync with the
// inline <head> script in index.html so the first paint doesn't flash.
function initialTheme(): Theme {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function App() {
  const [data, setData] = useState<ActivityFeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState(false);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#eef0f4" : "#0e0f13");
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // Map or analytics page. The map mounts the first time it is shown, then stays mounted
  // underneath analytics, so switching back keeps its camera and selection.
  const [view, setView] = useView();
  const [mapMounted, setMapMounted] = useState(view === "map");
  useEffect(() => {
    if (view === "map") setMapMounted(true);
  }, [view]);
  // The route preview is up (or has nothing to show), so the map can load.
  const [previewSettled, setPreviewSettled] = useState(false);
  // The map has drawn the routes, so the route preview can go.
  const [mapDrawn, setMapDrawn] = useState(false);

  // index.css keys the panel material off the page: see-through glass on the map only.
  useEffect(() => {
    document.documentElement.dataset.view = view;
  }, [view]);

  // Panel collapse state. A resize across the narrow breakpoint overrides manual toggles.
  const panels = useCollapsiblePanels();

  // Which activities are shown. null until data loads.
  const [filter, setFilter] = useState<ActivityFilter | null>(null);
  // Bumped when a pick sets a place (not when one is cleared), so the map flies to it.
  const [placeFlyEpoch, setPlaceFlyEpoch] = useState(0);
  const changeFilter = (next: ActivityFilter) => {
    if (next.place !== null && next.place !== filter?.place) setPlaceFlyEpoch((n) => n + 1);
    setFilter(next);
  };
  // The places and same-route groups the activities belong to (places.json).
  const [placesFile, setPlacesFile] = useState<PlacesFile>(NO_PLACES);
  const placeMap = useMemo(
    () => new Map<string, Place>(placesFile.places.map((p) => [p.id, p])),
    [placesFile],
  );
  const routeMap = useMemo(
    () => new Map<string, string>(placesFile.routes.map((r) => [r.id, r.name])),
    [placesFile],
  );
  // A month isolated from the ridgeline and the range it replaced, for the second click.
  const [isolation, setIsolation] = useState<MonthIsolation | null>(null);
  const pickMonth = (month: number) => {
    if (!filter) return;
    const [next, memory] = toggleMonth(filter, month, isolation);
    setFilter(next);
    setIsolation(memory);
  };

  const [colorMode, setColorMode] = useState<ColorMode>("uniform");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // The shared chart/map cursor: an index into the selected activity's detail samples.
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => setCursor(null), [selectedId]);

  // Replay transport. `progress` is the single source of truth (0..1); App runs
  // the rAF clock while playing and MapView renders whatever frame it resolves to.
  const [replaying, setReplaying] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [replayEpoch, setReplayEpoch] = useState(0);

  useEffect(() => {
    Promise.all([
      fetchJson<RoutesFile>(ROUTES_URL),
      fetchJson<ActivitiesFile>(ACTIVITIES_URL),
      fetchPlaces(),
    ])
      .then(([routes, activities, places]) => {
        const decoded = joinActivities(routes, activities);
        setData(decoded);
        setPlacesFile(places);
        // Over every record, routed or not: the analytics page reads them all, and the
        // map draws the ones with a route (visibleFeatures).
        setFilter(createActivityFilter(activities.activities));
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Visible activities: what both pages count and total. The map draws the subset with
  // a route.
  const visible = useMemo(() => (filter ? visibleActivities(filter) : []), [filter]);
  const visibleOnMap = useMemo(
    () => (filter && data ? visibleFeatures(filter, data.features) : []),
    [filter, data],
  );
  const mapFilter = useMemo(() => (filter ? filterExpression(filter) : null), [filter]);

  // Color scale domain from the visible set, so the recency and speed ramps span what's
  // actually shown. Type colors are fixed per type (colors.ts), so a type never changes
  // color as others are toggled off.
  const colorDomain = useMemo(
    () => ({
      ...computeDomain(visibleOnMap),
      types: [...(filter?.availableTypes ?? [])],
    }),
    [visibleOnMap, filter?.availableTypes],
  );

  // The Grade color mode colors routes by grade, from the route profiles: fetched the
  // first time it is picked, then split into grade runs once per data load.
  const profiles = useRouteProfiles(colorMode === "grade");
  const grade = useMemo(
    () => (data && profiles.status === "ready" ? gradeRoutes(data, profiles.file) : null),
    [data, profiles],
  );

  // Distance comparisons: the city each group's distance would reach, on the analytics
  // page, and the one group whose route the map shows (null: none). The cities are
  // fetched the first time either needs them.
  const [cityProfile, setCityProfile] = useState<Profile | null>(null);
  const [cityEpoch, setCityEpoch] = useState(0);
  const cities = useCities(view === "analytics" || cityProfile != null);
  const comparisons = useMemo(
    () => (cities.status === "ready" ? cityComparisons(visible, cities.data.cities) : []),
    [cities, visible],
  );
  const shownCity = useMemo(
    () => (cityProfile ? (comparisons.find((c) => c.profile === cityProfile) ?? null) : null),
    [comparisons, cityProfile],
  );
  // The route follows the filter to whatever city the new total reaches; a filter that
  // leaves the group no distance takes it down.
  useEffect(() => {
    if (cityProfile && cities.status === "ready" && !shownCity) setCityProfile(null);
  }, [cityProfile, cities.status, shownCity]);
  const cityRoute = useMemo<CityRouteLine | null>(
    () =>
      shownCity && cities.status === "ready"
        ? {
            key: `${shownCity.profile}:${shownCity.pick.city.id}`,
            coords: shownCity.pick.route.coords,
            originName: cities.data.origin.name,
            cityName: shownCity.pick.city.name,
          }
        : null,
    [shownCity, cities],
  );
  // "Show on map" on the analytics page. The route and a selected activity share the
  // bottom panel, so one replaces the other.
  const showCity = (profile: Profile) => {
    setSelectedId(null);
    setCityProfile(profile);
    setCityEpoch((n) => n + 1);
    panels.expandBottom();
    setView("map");
  };
  const selectActivity = (id: string) => {
    setSelectedId(id);
    setCityProfile(null);
    // On desktop show the activity's stats; the phone's sheet stays at its peek, so the
    // route keeps the screen until the user pulls the sheet up.
    if (!panels.mobile) panels.expandBottom();
    else panels.closeSide();
  };
  // A click on empty map clears both.
  const deselect = () => {
    setSelectedId(null);
    setCityProfile(null);
  };

  // Chronological step list for the visible activities, and the frame the
  // current progress resolves to. Memoized so MapView's frame effect only fires
  // when the resolved frame actually changes.
  const timeline = useMemo(() => buildTimeline(visibleOnMap), [visibleOnMap]);
  const replayFrame = useMemo(
    () => (replaying ? frameAt(timeline, progress) : null),
    [replaying, timeline, progress],
  );
  const atEnd = progress >= 1;

  // The rAF transport: while playing, advance progress by dt / (duration / speed).
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const replayingRef = useRef(replaying);
  replayingRef.current = replaying;

  useEffect(() => {
    if (!playing) return;
    const duration = totalDurationMs(timeline.length);
    if (duration <= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const next = progressRef.current + (dt * speedRef.current) / duration;
      if (next >= 1) {
        setProgress(1);
        setPlaying(false); // rest at the end; play acts as restart from here
        return;
      }
      setProgress(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline.length]);

  const startReplay = () => {
    if (timeline.length === 0) return;
    setSelectedId(null);
    setCityProfile(null);
    setHoverId(null);
    setCursor(null);
    setProgress(0);
    setReplaying(true);
    setReplayEpoch((n) => n + 1);
    // Playback starts from onReplayReady once MapView's fit-to-cluster fly-to lands, so
    // routes don't draw during the camera pan. (It always plays — an explicitly-requested
    // animation runs even under prefers-reduced-motion, like the selected-track fly-to.)
  };

  // MapView calls this when the entry fly-to settles; start playing if still in replay.
  const onReplayReady = () => {
    if (replayingRef.current) setPlaying(true);
  };

  const exitReplay = () => {
    setPlaying(false);
    setReplaying(false);
    setProgress(0);
  };

  const togglePlay = () => {
    if (atEnd && !playing) setProgress(0); // restart from the beginning
    setPlaying((v) => !v);
  };

  const seek = (g: number) => {
    setPlaying(false);
    setProgress(Math.min(1, Math.max(0, g)));
  };

  // Analytics hides the replay transport and covers the map, so leave replay and drop the
  // hover and the chart cursor (the map won't see the pointer leave). An effect, so
  // back/forward counts too.
  useEffect(() => {
    if (view === "map") return;
    exitReplay();
    setHoverId(null);
    setCursor(null);
  }, [view]);

  // If the filter empties the set mid-replay, back out gracefully.
  useEffect(() => {
    if (replaying && timeline.length === 0) exitReplay();
  }, [replaying, timeline.length]);

  // Esc backs out one step: the phone's filters overlay, then replay, then a selection
  // or a shown city route.
  const escRef = useRef<() => void>(() => {});
  escRef.current = () => {
    if (panels.mobile && !panels.sideCollapsed) panels.closeSide();
    else if (replaying) exitReplay();
    else if (selectedId != null || cityProfile != null) deselect();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      escRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The screen edges the panels cover, so the map frames routes in the free area: the
  // filters panel on the left and the detail panel on the right (desktop), and whatever
  // sits on the bottom edge, measured (the phone's sheet, or the replay bar).
  const [bottomPanelH, setBottomPanelH] = useState(0);
  const insets = useMemo(
    () =>
      chromeInsets({
        mobile: panels.mobile,
        sideOpen: !panels.sideCollapsed,
        detailOpen: !replaying && !panels.bottomCollapsed,
        bottomPanel: bottomPanelH,
      }),
    [panels.mobile, panels.sideCollapsed, panels.bottomCollapsed, replaying, bottomPanelH],
  );

  // The drawing activity, for the replay transport's readout.
  const namesById = useMemo(
    () => new Map((data?.features ?? []).map((f) => [f.properties.id, f.properties.name])),
    [data],
  );
  const replayCurrent = replayFrame
    ? { ts: replayFrame.ts, index: replayFrame.index, name: namesById.get(replayFrame.id) ?? "" }
    : null;

  const selectedFeature = useMemo(
    () =>
      selectedId == null || !data
        ? null
        : (data.features.find((f) => f.properties.id === selectedId) ?? null),
    [data, selectedId],
  );

  // The selected activity's samples and the charts built from them.
  const detailState = useActivityDetail(selectedId, selectedFeature?.properties.detail === true);
  const selectedDetail = detailState.status === "ready" ? detailState.detail : null;
  const profile = useMemo(
    () =>
      selectedDetail && selectedFeature
        ? buildProfile(selectedDetail, selectedFeature.properties.type)
        : null,
    [selectedDetail, selectedFeature],
  );

  const selectedShown = useMemo(
    () => selectedId != null && visibleOnMap.some((f) => f.properties.id === selectedId),
    [visibleOnMap, selectedId],
  );
  const cursorPoint = useMemo(
    () => markerPoint(selectedDetail, cursor, selectedShown),
    [selectedDetail, cursor, selectedShown],
  );

  // The selected activity's place and same-route rows. The route table is open while
  // the selection stays on the route it was opened on, so stepping through its rows
  // keeps it open and a new route never shows it open, not even for a frame. Leaving the
  // route forgets it (set during render, not in an effect), so coming back finds it shut.
  const [openRoute, setOpenRoute] = useState<string | null>(null);
  const selectedRoute = selectedFeature?.properties.route ?? null;
  if (openRoute !== null && openRoute !== selectedRoute) setOpenRoute(null);
  const routeOpen = openRoute !== null && openRoute === selectedRoute;
  const selectedPlaceLine = useMemo(
    () => (selectedFeature && filter ? placeLine(selectedFeature.properties, filter, placeMap) : null),
    [selectedFeature, filter, placeMap],
  );
  const selectedRouteTable = useMemo(
    () => (selectedFeature && filter ? routeTable(selectedFeature.properties, filter, routeMap) : null),
    [selectedFeature, filter, routeMap],
  );
  // While the route table is open, the map highlights its routes the filter shows.
  const groupIds = useMemo(
    () =>
      routeOpen && selectedRouteTable
        ? selectedRouteTable.rows.filter((r) => !r.outside).map((r) => r.id)
        : null,
    [routeOpen, selectedRouteTable],
  );
  // Like picking the place in the list, except that it never clears it: the row sets
  // the place (if it isn't already) and flies there, keeping this activity selected.
  const pickPlace = (id: string) => {
    if (!filter) return;
    if (filter.place !== id) setFilter(togglePlace(filter, id));
    setPlaceFlyEpoch((n) => n + 1);
  };
  // A table row outside the filter first widens the filter just enough to show it
  // (revealActivity leaves a row inside it as it is).
  const selectRouteMate = (id: string) => {
    const mate = filter?.activities.find((a) => a.id === id);
    if (filter && mate) changeFilter(revealActivity(filter, mate));
    selectActivity(id);
  };

  const charts = useMemo(() => {
    if (!selectedFeature) {
      return undefined;
    }
    if (selectedDetail && profile) {
      return (
        <ActivityCharts
          detail={selectedDetail}
          profile={profile}
          type={selectedFeature.properties.type}
          cursor={cursor}
          onCursor={setCursor}
        />
      );
    }
    return <p style={statusLine}>{detailMessage(detailState, profile != null)}</p>;
  }, [selectedFeature, selectedDetail, profile, cursor, detailState, shownCity]);
  // The place and route rows above the charts. Outside the memo: their handlers read
  // the current filter and panel layout.
  const panelBody = selectedFeature ? (
    <>
      <GroupRows
        place={selectedPlaceLine}
        route={selectedRouteTable}
        open={routeOpen}
        onToggle={() => setOpenRoute(routeOpen ? null : selectedRoute)}
        onPickPlace={pickPlace}
        onSelect={selectRouteMate}
      />
      {charts}
    </>
  ) : undefined;

  // InfoPanel content: selected activity, else the shown city route, else aggregate totals.
  const { title, subtitle, cards, links } = useMemo<{
    title: string;
    subtitle: string;
    cards: StatCard[];
    links: ActivityLink[];
  }>(() => {
    if (selectedFeature) {
      const p = selectedFeature.properties;
      return {
        title: p.name,
        subtitle: `${p.type} on ${formatDate(p.ts)}`,
        cards: activityCards(selectedFeature),
        links: activityLinks(p.sources),
      };
    }
    if (shownCity && cities.status === "ready") {
      const { origin } = cities.data;
      return {
        title: routeTitle(origin, shownCity.pick.city),
        subtitle: cityRouteSubtitle(shownCity),
        cards: cityCards(shownCity, origin),
        links: [],
      };
    }
    return {
      title: filter ? placeTitle(filter, placeMap) : "All activities",
      subtitle: filter ? `${formatMonthShort(filter.fromMonth)} – ${formatMonthShort(filter.toMonth)}` : "",
      cards: totalCards(visible),
      links: [],
    };
  }, [selectedFeature, shownCity, cities, visible, filter, placeMap]);

  // Nothing passes the filter: say so, and offer the way back.
  const resetFilter = () => {
    if (!filter) return;
    setFilter(createActivityFilter(filter.activities));
    setIsolation(null);
  };
  // Clear just the picked place; changeFilter never flies when the place goes.
  const clearPlace = () => {
    if (filter?.place != null) changeFilter(togglePlace(filter, filter.place));
  };
  // With a place picked, the notice names it and offers clearing just the place.
  const empty =
    filter && visible.length === 0 && !selectedFeature && !shownCity ? emptyNoticeFor(filter, placeMap) : null;
  const canClearPlace = empty?.clearPlace === true;
  const emptyNotice =
    filter && empty ? (
      <div style={{ padding: "4px 0 2px" }}>
        <p style={{ margin: "0 0 12px", fontSize: FS.sm + 0.5, lineHeight: 1.5, color: "var(--text-soft)" }}>
          {empty.text}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {canClearPlace && (
            <button type="button" className="ctl-accent" style={primaryButton} onClick={clearPlace}>
              Clear place
            </button>
          )}
          {/* Second to Clear place when that is offered: the narrower way back. */}
          <button
            type="button"
            className={canClearPlace ? "ctl" : "ctl-accent"}
            style={canClearPlace ? { ...secondaryButton, height: 36 } : primaryButton}
            onClick={resetFilter}
          >
            Reset filters
          </button>
        </div>
      </div>
    ) : undefined;

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)" }}>
      {/* DOM order is the tab order: header, filters, page content, then the map. */}
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        view={view}
        onViewChange={setView}
        onMapIntent={prefetchMapView}
        filtersOpen={filter ? !panels.sideCollapsed : undefined}
        onToggleFilters={filter ? panels.toggleSide : undefined}
      />

      {filter && panels.mobile && !panels.sideCollapsed && (
        // Tapping outside the phone's filters overlay closes it.
        <div
          aria-hidden="true"
          onClick={panels.closeSide}
          style={{ position: "absolute", inset: 0, zIndex: 24, background: "var(--scrim)" }}
        />
      )}

      {filter && (
        <SidePanel
          filter={filter}
          onFilterChange={changeFilter}
          places={placesFile.places}
          shownCount={visible.length}
          colorMode={colorMode}
          colorDomain={colorDomain}
          onColorModeChange={setColorMode}
          theme={theme}
          onStartReplay={() => {
            if (panels.mobile) panels.closeSide();
            startReplay();
          }}
          canReplay={timeline.length > 0}
          showMapControls={view === "map"}
          sections={view === "analytics" && visible.length > 0 ? ANALYTICS_SECTIONS : undefined}
          collapsed={panels.sideCollapsed}
          onToggle={panels.toggleSide}
          mobile={panels.mobile}
        />
      )}

      {view === "analytics" && (
        <AnalyticsView
          filter={filter}
          visible={visible}
          sidePanelExpanded={!panels.sideCollapsed}
          mobile={panels.mobile}
          isolation={filter && activeIsolation(filter, isolation)}
          onPickMonth={pickMonth}
          cities={cities}
          comparisons={comparisons}
          onShowCity={showCity}
          onResetFilter={resetFilter}
          places={placeMap}
          onClearPlace={clearPlace}
          theme={theme}
        />
      )}

      {filter &&
        view === "map" &&
        (replaying ? (
          <ReplayBar
            playing={playing}
            progress={progress}
            current={replayCurrent}
            total={timeline.length}
            speed={speed}
            atEnd={atEnd}
            onPlayPause={togglePlay}
            onSeek={seek}
            onSpeed={setSpeed}
            onExit={exitReplay}
            mobile={panels.mobile}
            onHeight={setBottomPanelH}
          />
        ) : (
          <InfoPanel
            title={empty && !canClearPlace ? "Nothing to show" : title}
            titleNode={
              !selectedFeature && shownCity && cities.status === "ready" ? (
                <RouteTitle from={cities.data.origin.name} to={shownCity.pick.city.name} />
              ) : undefined
            }
            onClose={selectedFeature || shownCity ? deselect : undefined}
            closeLabel={selectedFeature ? "Back to all activities" : "Hide route"}
            subtitle={subtitle}
            cards={cards}
            links={links}
            body={panelBody}
            notice={emptyNotice}
            collapsed={panels.bottomCollapsed}
            onToggle={panels.toggleBottom}
            mobile={panels.mobile}
            onHeight={panels.mobile ? setBottomPanelH : undefined}
          />
        ))}

      {!filter && !error && (
        <div role="status" style={{ ...chip, top: "50%", transform: "translate(-50%, -50%)" }}>
          <span className="pulse-dot" style={pulseDot} />
          Loading activities…
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...chip, top: 76, color: "var(--accent-text)" }}>
          Couldn't load activities: {error}
        </div>
      )}

      {/* A data error already explains the empty map; don't stack a second chip on it. */}
      {mapFailed && !error && view === "map" && (
        <div role="alert" style={{ ...chip, top: 76, color: "var(--accent-text)" }}>
          Couldn't load the map.
          <button
            type="button"
            className="ctl"
            style={{ ...secondaryButton, height: 28 }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      )}

      {/* inert while covered, so keyboard focus can't land on the hidden map. */}
      {mapMounted && (
        <div inert={view !== "map"} style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          {/* After the preview, or at once if the routes failed to load. */}
          {(previewSettled || error != null) && (
            <MapErrorBoundary onError={() => setMapFailed(true)}>
              <Suspense fallback={null}>
                <MapView
                  theme={theme}
                  data={data}
                  mapFilter={mapFilter}
                  visible={visibleOnMap}
                  colorMode={colorMode}
                  colorDomain={colorDomain}
                  grade={grade}
                  hoverId={hoverId}
                  groupIds={groupIds}
                  selectedId={selectedId}
                  onHover={setHoverId}
                  onSelect={selectActivity}
                  onDeselect={deselect}
                  replaying={replaying}
                  replayFrame={replayFrame}
                  replayTimeline={timeline}
                  replayEpoch={replayEpoch}
                  placeFlyEpoch={placeFlyEpoch}
                  onReplayReady={onReplayReady}
                  insets={insets}
                  cursorPoint={cursorPoint}
                  selectedDetail={selectedDetail}
                  onCursor={setCursor}
                  cityRoute={cityRoute}
                  cityRouteEpoch={cityEpoch}
                  onRoutesShown={() => setMapDrawn(true)}
                />
              </Suspense>
            </MapErrorBoundary>
          )}
          {/* Over the map's canvas: the routes until the map draws its own. */}
          {data && (
            <RoutePreview
              features={visibleOnMap}
              insets={insets}
              done={mapDrawn}
              onSettled={() => setPreviewSettled(true)}
            />
          )}
        </div>
      )}

      {/* Vignette for depth (decorative, click-through). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 10,
          pointerEvents: "none",
          boxShadow: "var(--vignette-shadow)",
          background: "var(--vignette-bg)",
          transition: "box-shadow .35s ease, background .35s ease",
        }}
      />
    </div>
  );
}

/** "Ljubljana → Dnipro", with the same arrow the analytics page uses. */
function RouteTitle({ from, to }: { from: string; to: string }) {
  return (
    <>
      {from}{" "}
      <span style={{ color: "var(--accent-text)", display: "inline-flex", verticalAlign: "-2px" }}>
        <ArrowRightIcon size={15} />
        <span className="sr-only">to</span>
      </span>{" "}
      {to}
    </>
  );
}

// A small floating status chip (loading, load error).
const chip: CSSProperties = {
  position: "absolute",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  borderRadius: 999,
  fontSize: FS.sm + 0.5,
  fontWeight: 500,
  color: "var(--text)",
  background: "var(--panel-bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "var(--panel-shadow)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
};

const pulseDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "var(--accent)",
};

// The muted line in place of charts (loading, failed, or no samples).
const statusLine: CSSProperties = {
  margin: "14px 0 0",
  fontSize: FS.sm,
  color: "var(--text-muted)",
};
