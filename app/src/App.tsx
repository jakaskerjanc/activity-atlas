// Top-level wiring: load the GeoJSON once, own all UI state, and feed the map + the
// Trace Atlas panels. Which activities are shown is the Activity filter's call
// (activityFilter.ts); this file holds it and hands its results to the map and panels.

import { useEffect, useMemo, useRef, useState } from "react";
import { MapView } from "./MapView";
import { Header } from "./ui/Header";
import { SidePanel } from "./ui/SidePanel";
import { InfoPanel } from "./ui/InfoPanel";
import { ReplayBar } from "./ui/ReplayBar";
import {
  createActivityFilter,
  filterExpression,
  visibleActivities,
  type ActivityFilter,
} from "./activityFilter";
import type { ActivityFeatureCollection, TrackPayload, Theme } from "./types";
import { decodeTracks } from "./tracks";
import { formatDate, formatMonth, activityLink } from "./format";
import { activityCards, totalCards, type StatCard } from "./stats";
import { computeDomain, type ColorMode } from "./colors";
import { buildTimeline, frameAt, totalDurationMs } from "./replay";
import { useCollapsiblePanels } from "./ui/useCollapsiblePanels";

const DATA_URL = `${import.meta.env.BASE_URL}tracks.json`;

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

  // Panel collapse state. A resize across the narrow breakpoint overrides manual toggles.
  const panels = useCollapsiblePanels();

  // Which activities are shown. null until data loads.
  const [filter, setFilter] = useState<ActivityFilter | null>(null);

  const [colorMode, setColorMode] = useState<ColorMode>("uniform");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Replay transport. `progress` is the single source of truth (0..1); App runs
  // the rAF clock while playing and MapView renders whatever frame it resolves to.
  const [replaying, setReplaying] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [replayEpoch, setReplayEpoch] = useState(0);

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((payload: TrackPayload) => {
        const decoded = decodeTracks(payload);
        setData(decoded);
        setFilter(createActivityFilter(decoded.features));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const visible = useMemo(() => (filter ? visibleActivities(filter) : []), [filter]);
  const mapFilter = useMemo(() => (filter ? filterExpression(filter) : null), [filter]);

  // Color scale domain from the visible set, so recency/elevation/speed ramps
  // span what's actually shown. Type→color stays keyed to the full type list
  // (availableTypes) so a type doesn't change color as others are toggled off.
  const colorDomain = useMemo(
    () => ({ ...computeDomain(visible), types: [...(filter?.availableTypes ?? [])] }),
    [visible, filter?.availableTypes],
  );

  // Chronological step list for the visible activities, and the frame the
  // current progress resolves to. Memoized so MapView's frame effect only fires
  // when the resolved frame actually changes.
  const timeline = useMemo(() => buildTimeline(visible), [visible]);
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

  // InfoPanel content: selected activity, or aggregate totals.
  const { title, subtitle, cards, link } = useMemo<{
    title: string;
    subtitle: string;
    cards: StatCard[];
    link: { url: string; label: string } | null;
  }>(() => {
    if (selectedFeature) {
      const p = selectedFeature.properties;
      return {
        title: p.name,
        subtitle: `${p.type} · ${formatDate(p.ts)}`,
        cards: activityCards(selectedFeature),
        link: activityLink(p.id),
      };
    }
    return {
      title: "All Activities",
      subtitle: filter ? `${formatMonth(filter.fromMonth)} — ${formatMonth(filter.toMonth)}` : "",
      cards: totalCards(visible),
      link: null,
    };
  }, [selectedFeature, visible, filter?.fromMonth, filter?.toMonth]);

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)" }}>
      <MapView
        theme={theme}
        data={data}
        mapFilter={mapFilter}
        visible={visible}
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
      />

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

      <Header theme={theme} onToggleTheme={toggleTheme} />

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
            collapsed={panels.sideCollapsed}
            onToggle={panels.toggleSide}
          />
          {replaying ? (
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
              link={link}
              collapsed={panels.bottomCollapsed}
              onToggle={panels.toggleBottom}
            />
          )}
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
