// Top-level wiring: load the GeoJSON once, own all UI state, and feed the map + the
// Trace Atlas panels. Which activities are shown is the Activity filter's call
// (activityFilter.ts); this file holds it and hands its results to the map, the
// analytics page, and the panels.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MapView } from "./MapView";
import { Header } from "./ui/Header";
import { SidePanel } from "./ui/SidePanel";
import { InfoPanel } from "./ui/InfoPanel";
import { ReplayBar } from "./ui/ReplayBar";
import { AnalyticsView } from "./ui/AnalyticsView";
import { useView } from "./ui/useView";
import {
  createActivityFilter,
  activeIsolation,
  filterExpression,
  toggleMonth,
  visibleActivities,
  visibleFeatures,
  type ActivityFilter,
  type MonthIsolation,
} from "./activityFilter";
import type { ActivitiesFile, ActivityFeatureCollection, RoutesFile, Theme } from "./types";
import { joinActivities } from "./tracks";
import { formatDate, formatMonth, activityLinks } from "./format";
import { activityCards, totalCards, type StatCard } from "./stats";
import { computeDomain, type ColorMode } from "./colors";
import { buildTimeline, frameAt, totalDurationMs } from "./replay";
import { useCollapsiblePanels } from "./ui/useCollapsiblePanels";
import { useActivityDetail } from "./ui/useActivityDetail";
import { ActivityCharts, detailMessage } from "./ui/ActivityCharts";
import { buildProfile } from "./profile";
import { markerPoint } from "./routeCursor";

const ROUTES_URL = `${import.meta.env.BASE_URL}data/routes.json`;
const ACTIVITIES_URL = `${import.meta.env.BASE_URL}data/activities.json`;

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
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

  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "light" ? "#eef0f4" : "#0e0f13");
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // Map or analytics page. The map stays mounted underneath analytics, so switching back
  // keeps its camera and selection.
  const [view, setView] = useView();

  // Panel collapse state. A resize across the narrow breakpoint overrides manual toggles.
  const panels = useCollapsiblePanels();

  // Which activities are shown. null until data loads.
  const [filter, setFilter] = useState<ActivityFilter | null>(null);
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
    Promise.all([fetchJson<RoutesFile>(ROUTES_URL), fetchJson<ActivitiesFile>(ACTIVITIES_URL)])
      .then(([routes, activities]) => {
        const decoded = joinActivities(routes, activities);
        setData(decoded);
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

  // Color scale domain from the visible set, so recency/elevation/speed ramps
  // span what's actually shown. Type→color stays keyed to the full type list
  // (availableTypes) so a type doesn't change color as others are toggled off.
  const colorDomain = useMemo(
    () => ({ ...computeDomain(visibleOnMap), types: [...(filter?.availableTypes ?? [])] }),
    [visibleOnMap, filter?.availableTypes],
  );

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
    setHoverId(null);
    setCursor(null);
    setProgress(0);
    setReplaying(true);
    setReplayEpoch((n) => n + 1);
    panels.expandBottom(); // reveal the transport if the user had it collapsed
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

  const panelBody = useMemo(() => {
    if (!selectedFeature) return undefined;
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
  }, [selectedFeature, selectedDetail, profile, cursor, detailState]);

  // InfoPanel content: selected activity, or aggregate totals.
  const { title, subtitle, cards, links } = useMemo<{
    title: string;
    subtitle: string;
    cards: StatCard[];
    links: { url: string; label: string }[];
  }>(() => {
    if (selectedFeature) {
      const p = selectedFeature.properties;
      return {
        title: p.name,
        subtitle: `${p.type} · ${formatDate(p.ts)}`,
        cards: activityCards(selectedFeature),
        links: activityLinks(p.sources),
      };
    }
    return {
      title: "All Activities",
      subtitle: filter ? `${formatMonth(filter.fromMonth)} — ${formatMonth(filter.toMonth)}` : "",
      cards: totalCards(visible),
      links: [],
    };
  }, [selectedFeature, visible, filter?.fromMonth, filter?.toMonth]);

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)" }}>
      {/* inert while covered, so keyboard focus can't land on the hidden map. */}
      <div inert={view !== "map"} style={{ position: "absolute", inset: 0 }}>
        <MapView
          theme={theme}
          data={data}
          mapFilter={mapFilter}
          visible={visibleOnMap}
          colorMode={colorMode}
          colorDomain={colorDomain}
          hoverId={hoverId}
          selectedId={selectedId}
          onHover={setHoverId}
          onSelect={setSelectedId}
          onDeselect={() => setSelectedId(null)}
          replaying={replaying}
          replayFrame={replayFrame}
          replayEpoch={replayEpoch}
          onReplayReady={onReplayReady}
          sidePanelExpanded={!panels.sideCollapsed}
          cursorPoint={cursorPoint}
          selectedDetail={selectedDetail}
          onCursor={setCursor}
        />
      </div>

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

      {view === "analytics" && (
        <AnalyticsView
          filter={filter}
          visible={visible}
          sidePanelExpanded={!panels.sideCollapsed}
          theme={theme}
          isolation={filter && activeIsolation(filter, isolation)}
          onPickMonth={pickMonth}
        />
      )}

      <Header theme={theme} onToggleTheme={toggleTheme} view={view} onViewChange={setView} />

      {filter && (
        <>
          <SidePanel
            filter={filter}
            onFilterChange={setFilter}
            colorMode={colorMode}
            colorDomain={colorDomain}
            onColorModeChange={setColorMode}
            onStartReplay={startReplay}
            canReplay={timeline.length > 0}
            showMapControls={view === "map"}
            collapsed={panels.sideCollapsed}
            onToggle={panels.toggleSide}
          />
          {view === "map" &&
            (replaying ? (
              <ReplayBar
                playing={playing}
                progress={progress}
                dateTs={replayFrame?.ts ?? null}
                speed={speed}
                atEnd={atEnd}
                onPlayPause={togglePlay}
                onSeek={seek}
                onSpeed={setSpeed}
                onExit={exitReplay}
                collapsed={panels.bottomCollapsed}
                onToggle={panels.toggleBottom}
              />
            ) : (
              <InfoPanel
                title={title}
                subtitle={subtitle}
                cards={cards}
                links={links}
                body={panelBody}
                compactCards={profile != null}
                collapsed={panels.bottomCollapsed}
                onToggle={panels.toggleBottom}
              />
            ))}
        </>
      )}

      {error && (
        <div
          style={{
            position: "absolute",
            top: 70,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            color: "var(--accent-text)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            background: "var(--panel-bg)",
            border: "1px solid var(--panel-border)",
            backdropFilter: "var(--panel-blur)",
            WebkitBackdropFilter: "var(--panel-blur)",
            padding: "8px 14px",
            borderRadius: 10,
          }}
        >
          Failed to load activities: {error}
        </div>
      )}
    </div>
  );
}

// The muted line in place of charts (loading, failed, or no samples).
const statusLine: CSSProperties = {
  margin: "12px 0 0",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  color: "var(--text-muted)",
};
