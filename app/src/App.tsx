// Top-level wiring: load the GeoJSON once, own all UI state, and feed the map + the
// Trace Atlas panels. The map/data/filter contract (MapView, filters.ts) is unchanged;
// this file just composes the design's chrome around it.

import { useEffect, useMemo, useRef, useState } from "react";
import { MapView } from "./MapView";
import { Header } from "./ui/Header";
import { SidePanel } from "./ui/SidePanel";
import { InfoPanel } from "./ui/InfoPanel";
import { ReplayBar } from "./ui/ReplayBar";
import type { FilterState } from "./filters";
import type { ActivityFeatureCollection, TrackPayload, Theme } from "./types";
import { decodeTracks } from "./tracks";
import { formatDate, formatDateYear } from "./format";
import { activityCards, totalCards, type StatCard } from "./stats";
import { computeDomain, type ColorMode } from "./colors";
import { buildTimeline, frameAt, totalDurationMs } from "./replay";

const DATA_URL = `${import.meta.env.BASE_URL}tracks.json`;
// A type value no activity can have — used to express "show none" through buildFilter,
// whose empty-array case means "show all".
const NONE_SENTINEL = " __none__";

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

  // Types shown. null until data loads, then initialized to "all on".
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  const [from, setFrom] = useState<number | undefined>();
  const [to, setTo] = useState<number | undefined>();

  const [colorMode, setColorMode] = useState<ColorMode>("recency");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);

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
      .then((payload: TrackPayload) => setData(decodeTracks(payload)))
      .catch((e) => setError(String(e)));
  }, []);

  const availableTypes = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.features.map((f) => f.properties.type))].sort();
  }, [data]);

  const [tsMin, tsMax] = useMemo(() => {
    if (!data || data.features.length === 0) return [0, 0];
    const ts = data.features.map((f) => f.properties.ts);
    return [Math.min(...ts), Math.max(...ts)];
  }, [data]);

  // Initialize the enabled set once types are known.
  useEffect(() => {
    if (data && enabled === null) setEnabled(new Set(availableTypes));
  }, [data, availableTypes, enabled]);

  const fromVal = from ?? tsMin;
  const toVal = to ?? tsMax;
  const enabledTypes = enabled ?? new Set(availableTypes);

  // Translate UI state into the map's FilterState.
  const filter: FilterState = useMemo(() => {
    const types =
      enabled === null
        ? []
        : enabled.size === 0
          ? [NONE_SENTINEL]
          : [...enabled];
    return { types, from: fromVal, to: toVal };
  }, [enabled, fromVal, toVal]);

  const inWindow = (ts: number) => ts >= fromVal && ts <= toVal;

  // Features currently visible under the type + date filters. Shared by the
  // color scale and the aggregate totals.
  const filteredFeatures = useMemo(
    () =>
      data
        ? data.features.filter(
            (f) => enabledTypes.has(f.properties.type) && inWindow(f.properties.ts),
          )
        : [],
    [data, enabledTypes, fromVal, toVal],
  );

  // Color scale domain from the visible set, so recency/elevation/speed ramps
  // span what's actually shown. Type→color stays keyed to the full type list
  // (availableTypes) so a type doesn't change color as others are toggled off.
  const colorDomain = useMemo(
    () => ({ ...computeDomain(filteredFeatures), types: availableTypes }),
    [filteredFeatures, availableTypes],
  );

  // Chronological step list for the currently filtered set, and the frame the
  // current progress resolves to. Memoized so MapView's frame effect only fires
  // when the resolved frame actually changes.
  const timeline = useMemo(() => buildTimeline(filteredFeatures), [filteredFeatures]);
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

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (data) {
      for (const f of data.features) {
        if (inWindow(f.properties.ts)) {
          counts[f.properties.type] = (counts[f.properties.type] ?? 0) + 1;
        }
      }
    }
    return counts;
  }, [data, fromVal, toVal]);

  const selectedFeature = useMemo(
    () =>
      selectedId == null || !data
        ? null
        : (data.features.find((f) => f.properties.id === selectedId) ?? null),
    [data, selectedId],
  );

  // InfoPanel content: selected activity, or aggregate totals.
  const { title, subtitle, cards, stravaUrl } = useMemo<{
    title: string;
    subtitle: string;
    cards: StatCard[];
    stravaUrl: string | null;
  }>(() => {
    if (selectedFeature) {
      const p = selectedFeature.properties;
      return {
        title: p.name,
        subtitle: `${p.type} · ${formatDateYear(p.ts)}`,
        cards: activityCards(selectedFeature),
        stravaUrl: `https://www.strava.com/activities/${p.id}`,
      };
    }
    return {
      title: "All Activities",
      subtitle: `${formatDate(fromVal)} — ${formatDate(toVal)}`,
      cards: totalCards(filteredFeatures),
      stravaUrl: null,
    };
  }, [selectedFeature, filteredFeatures, fromVal, toVal]);

  const toggleType = (t: string) =>
    setEnabled((prev) => {
      const next = new Set(prev ?? availableTypes);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });

  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)" }}>
      <MapView
        theme={theme}
        data={data}
        filter={filter}
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

      {data && (
        <>
          <SidePanel
            theme={theme}
            availableTypes={availableTypes}
            typeCounts={typeCounts}
            enabledTypes={enabledTypes}
            onToggleType={toggleType}
            tsMin={tsMin}
            tsMax={tsMax}
            from={fromVal}
            to={toVal}
            onFromChange={(ts) => setFrom(Math.min(ts, toVal))}
            onToChange={(ts) => setTo(Math.max(ts, fromVal))}
            colorMode={colorMode}
            colorDomain={colorDomain}
            onColorModeChange={setColorMode}
            onStartReplay={startReplay}
            canReplay={timeline.length > 0}
          />
          {replaying ? (
            <ReplayBar
              theme={theme}
              playing={playing}
              progress={progress}
              dateTs={replayFrame?.ts ?? null}
              speed={speed}
              atEnd={atEnd}
              onPlayPause={togglePlay}
              onSeek={seek}
              onSpeed={setSpeed}
              onExit={exitReplay}
            />
          ) : (
            <InfoPanel
              theme={theme}
              title={title}
              subtitle={subtitle}
              cards={cards}
              stravaUrl={stravaUrl}
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
