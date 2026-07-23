// Owns the Mapbox GL map. Renders activity routes as a glow + core line pair in the
// Trace Atlas style, drives hover/selection highlighting, and plays a fade-in reveal
// (re-triggered by REPLAY). Filtering + the GeoJSON data contract are unchanged.

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { ExpressionSpecification } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { buildFilter, type FilterState } from "./filters";
import {
  ACCENT,
  lineColorExpression,
  type ColorMode,
  type ColorDomain,
} from "./colors";
import type { ReplayFrame } from "./replay";
import { densestClusterBounds } from "./cluster";
import type { ActivityFeatureCollection, Theme } from "./types";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

/** Base map that reads well under each theme's panels. Light uses the toned streets
 * style (roads/parks/water) so the translucent liquid-glass panels have real color
 * to refract; dark stays the muted dark base. */
const STYLE_URL: Record<Theme, string> = {
  dark: "mapbox://styles/mapbox/dark-v11",
  light: "mapbox://styles/mapbox/streets-v12",
};

const SOURCE_ID = "activities";
const GLOW_ID = "activities-glow";
const CORE_ID = "activities-core";
// The single route currently drawing in replay gets its own layers on top, so
// line-trim-offset (a per-layer paint prop) reveals just it while completed routes
// stay fully painted underneath.
const ACTIVE_GLOW_ID = "activities-active-glow";
const ACTIVE_CORE_ID = "activities-active-core";
const FADE_MS = 1200;

/** Matches nothing — parks the active layers when no route is drawing. */
const MATCH_NONE: ExpressionSpecification = ["==", ["get", "id"], -1];

interface Props {
  /** Selects the Mapbox base style; the panels themselves are themed in CSS. */
  theme: Theme;
  data: ActivityFeatureCollection | null;
  filter: FilterState;
  colorMode: ColorMode;
  colorDomain: ColorDomain;
  hoverId: number | null;
  selectedId: number | null;
  onHover: (id: number | null) => void;
  onSelect: (id: number) => void;
  onDeselect: () => void;
  /** True while replay owns the map; suspends hover/select highlighting + the plain filter. */
  replaying: boolean;
  /** Current replay frame (null when idle). Drives the completed/active split + trim. */
  replayFrame: ReplayFrame | null;
  /** Signals replay just became active — used to fit the camera to the filtered set once. */
  replayEpoch: number;
  /** Called once the entry fit-to-cluster fly-to settles, so playback starts after the pan. */
  onReplayReady: () => void;
}

/** Padding that keeps a fitted track centered in the strip between the panels. */
const FIT_PADDING = { top: 90, bottom: 80, left: 330, right: 360 };

/** Home view on initial load: Slovenia, centered on Ljubljana. */
const SLOVENIA_CENTER: [number, number] = [14.5058, 46.0569];
const SLOVENIA_ZOOM = 7.6;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function MapView(props: Props) {
  const { data, filter, colorMode, colorDomain, hoverId, selectedId } = props;
  const { replaying, replayFrame, replayEpoch } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const loadedRef = useRef(false);
  // Base style currently applied to the map, so the theme effect only calls
  // setStyle when it actually changes.
  const appliedStyleRef = useRef<string>("");

  // Latest props for event handlers registered once on the map.
  const propsRef = useRef(props);
  propsRef.current = props;

  const fadeRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const activeId = hoverId ?? selectedId;
  const activeRef = useRef<number | null>(activeId);
  activeRef.current = activeId;

  /** Repaint both layers for the current active track + fade factor. */
  function applyPaint() {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID)) return;
    const f = fadeRef.current;
    // In replay the base layers carry the accumulated (completed) routes at their
    // resting look — hover/select highlighting and the fade are both suspended.
    const active = propsRef.current.replaying ? null : activeRef.current;
    // Heat mode drops the per-line opacity so overlapping corridors accumulate
    // toward full accent — density, not hue, carries the signal.
    const heat = propsRef.current.colorMode === "heat";
    const glowW = heat ? 5 : 6;
    const coreW = heat ? 1.8 : 2.6;

    if (active == null) {
      map.setPaintProperty(GLOW_ID, "line-opacity", (heat ? 0.14 : 0.2) * f);
      map.setPaintProperty(GLOW_ID, "line-width", glowW);
      map.setPaintProperty(CORE_ID, "line-opacity", (heat ? 0.34 : 0.82) * f);
      map.setPaintProperty(CORE_ID, "line-width", coreW);
      return;
    }
    const match: ExpressionSpecification = ["==", ["get", "id"], active];
    const dimGlow = heat ? 0.04 : 0.05;
    const dimCore = heat ? 0.1 : 0.16;
    map.setPaintProperty(GLOW_ID, "line-opacity", ["case", match, 0.5 * f, dimGlow * f]);
    map.setPaintProperty(GLOW_ID, "line-width", ["case", match, 10, glowW]);
    map.setPaintProperty(CORE_ID, "line-opacity", ["case", match, 1 * f, dimCore * f]);
    map.setPaintProperty(CORE_ID, "line-width", ["case", match, 4.6, coreW]);
  }

  /** Set the data-driven line color for a mode; core gains blur in heat mode. */
  function applyColor(mode: ColorMode, domain: ColorDomain) {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID)) return;
    const color = lineColorExpression(mode, domain);
    map.setPaintProperty(GLOW_ID, "line-color", color);
    map.setPaintProperty(CORE_ID, "line-color", color);
    map.setPaintProperty(CORE_ID, "line-blur", mode === "heat" ? 2 : 0);
    // The drawing route follows the same color scale so it reads as one of the set.
    map.setPaintProperty(ACTIVE_GLOW_ID, "line-color", color);
    map.setPaintProperty(ACTIVE_CORE_ID, "line-color", color);
  }

  /**
   * Reflect a replay frame onto the map: base layers show the completed set
   * (everything before the drawing route), the active layers reveal just the
   * drawing route up to its trim. A null frame parks the active layers and hands
   * the base layers back to the plain user filter.
   */
  function applyReplay(frame: ReplayFrame | null) {
    const map = mapRef.current;
    if (!map || !map.getLayer(ACTIVE_GLOW_ID)) return;

    if (!frame) {
      map.setFilter(ACTIVE_GLOW_ID, MATCH_NONE);
      map.setFilter(ACTIVE_CORE_ID, MATCH_NONE);
      const base = buildFilter(propsRef.current.filter);
      map.setFilter(GLOW_ID, base);
      map.setFilter(CORE_ID, base);
      return;
    }

    const user = buildFilter(propsRef.current.filter);
    // "Before the drawing route" in the exact order buildTimeline uses: ts, then id as
    // the tiebreak. Keying on the pair (not ts alone) keeps same-second activities from
    // flickering out while a route sharing their timestamp draws.
    const before: ExpressionSpecification = [
      "any",
      ["<", ["get", "ts"], frame.ts],
      ["all", ["==", ["get", "ts"], frame.ts], ["<", ["get", "id"], frame.id]],
    ];
    const completed = (
      user ? ["all", user, before] : before
    ) as ExpressionSpecification;
    map.setFilter(GLOW_ID, completed);
    map.setFilter(CORE_ID, completed);

    const only: ExpressionSpecification = ["==", ["get", "id"], frame.id];
    map.setFilter(ACTIVE_GLOW_ID, only);
    map.setFilter(ACTIVE_CORE_ID, only);
    // Hide the [trim, 1] tail so the line reveals from its start to `trim`.
    const tail: [number, number] = [frame.trim, 1];
    map.setPaintProperty(ACTIVE_GLOW_ID, "line-trim-offset", tail);
    map.setPaintProperty(ACTIVE_CORE_ID, "line-trim-offset", tail);
  }

  /** Animate the reveal from opacity 0 to full. */
  function startFade() {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID)) return;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (prefersReducedMotion()) {
      fadeRef.current = 1;
      applyPaint();
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      // Clamp low too: the rAF timestamp is the frame-start time and can be
      // marginally before t0, which would make p (and thus opacity) negative.
      const p = Math.max(0, Math.min(1, (now - t0) / FADE_MS));
      fadeRef.current = 1 - Math.pow(1 - p, 3); // easeOutCubic
      applyPaint();
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  /**
   * Add the source + the four route layers and set their initial filter/color.
   * Idempotent, so it can rebuild after a base-style swap (setStyle drops all
   * custom sources/layers) as well as on first load. Layer-scoped event handlers
   * are registered on the map instance once and rebind by layer id, so they keep
   * working across a rebuild.
   */
  function installLayers() {
    const map = mapRef.current;
    if (!map) return;
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        // Required for line-trim-offset (the replay draw-on reveal).
        lineMetrics: true,
      });
    }
    if (!map.getLayer(GLOW_ID)) {
      map.addLayer({
        id: GLOW_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ACCENT,
          "line-width": 6,
          "line-opacity": 0,
          "line-blur": 8,
        },
      });
    }
    if (!map.getLayer(CORE_ID)) {
      map.addLayer({
        id: CORE_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ACCENT, "line-width": 2.6, "line-opacity": 0 },
      });
    }
    // Active (drawing) route layers — on top, parked until replay runs.
    if (!map.getLayer(ACTIVE_GLOW_ID)) {
      map.addLayer({
        id: ACTIVE_GLOW_ID,
        type: "line",
        source: SOURCE_ID,
        filter: MATCH_NONE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ACCENT,
          "line-width": 11,
          "line-opacity": 0.55,
          "line-blur": 8,
          "line-trim-offset": [0, 1],
        },
      });
    }
    if (!map.getLayer(ACTIVE_CORE_ID)) {
      map.addLayer({
        id: ACTIVE_CORE_ID,
        type: "line",
        source: SOURCE_ID,
        filter: MATCH_NONE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ACCENT,
          "line-width": 4.4,
          "line-opacity": 1,
          "line-trim-offset": [0, 1],
        },
      });
    }
    map.setFilter(GLOW_ID, buildFilter(propsRef.current.filter));
    map.setFilter(CORE_ID, buildFilter(propsRef.current.filter));
    applyColor(propsRef.current.colorMode, propsRef.current.colorDomain);
  }

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: STYLE_URL[propsRef.current.theme],
      center: SLOVENIA_CENTER,
      zoom: SLOVENIA_ZOOM,
    });
    mapRef.current = map;
    appliedStyleRef.current = STYLE_URL[propsRef.current.theme];

    map.on("load", () => {
      installLayers();
      loadedRef.current = true;

      const d = propsRef.current.data;
      if (d) {
        // Map is already constructed at the home view; no jumpTo needed here.
        (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource).setData(d);
        startFade();
      }
    });

    // Hover highlighting (glow is the wider hit target). Suspended during replay.
    map.on("mousemove", GLOW_ID, (e) => {
      if (propsRef.current.replaying) return;
      const id = e.features?.[0]?.properties?.id as number | undefined;
      map.getCanvas().style.cursor = "pointer";
      if (id != null) propsRef.current.onHover(id);
    });
    map.on("mouseleave", GLOW_ID, () => {
      map.getCanvas().style.cursor = "";
      propsRef.current.onHover(null);
    });

    // Click a track selects it; click on empty map deselects. Inert during replay.
    map.on("click", (e) => {
      if (propsRef.current.replaying) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: [GLOW_ID] });
      const id = hits[0]?.properties?.id as number | undefined;
      if (id != null) propsRef.current.onSelect(id);
      else propsRef.current.onDeselect();
    });

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  // Swap the base map style when the theme changes. setStyle drops our source and
  // layers, so rebuild them on the next style.load and restore the current data,
  // color, filter/replay state, and resting paint — without moving the camera or
  // re-running the fade-in reveal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const url = STYLE_URL[props.theme];
    if (appliedStyleRef.current === url) return;
    appliedStyleRef.current = url;
    map.once("style.load", () => {
      installLayers();
      const d = propsRef.current.data;
      if (d) (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource).setData(d);
      fadeRef.current = 1;
      if (propsRef.current.replaying) applyReplay(propsRef.current.replayFrame);
      applyPaint();
    });
    map.setStyle(url);
  }, [props.theme]);

  // Update source when data arrives/changes, then replay the reveal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !data) return;
    (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
    map.jumpTo({ center: SLOVENIA_CENTER, zoom: SLOVENIA_ZOOM });
    startFade();
  }, [data]);

  // Apply filter changes. Skipped while replaying — applyReplay owns the base
  // layers' filter then (it folds the current filter into the completed set).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer(CORE_ID)) return;
    if (replaying) return;
    const expr = buildFilter(filter);
    map.setFilter(GLOW_ID, expr);
    map.setFilter(CORE_ID, expr);
  }, [filter, replaying]);

  // Recolor when the color mode or its value domain changes. applyPaint follows
  // so heat mode's dimmed base opacities take effect immediately.
  useEffect(() => {
    if (!loadedRef.current) return;
    applyColor(colorMode, colorDomain);
    applyPaint();
  }, [colorMode, colorDomain]);

  // Repaint highlight when the active track changes.
  useEffect(() => {
    applyPaint();
  }, [activeId]);

  // Reflect each replay frame (also restores the base filter when it goes null).
  useEffect(() => {
    if (!loadedRef.current) return;
    applyReplay(replayFrame);
  }, [replayFrame]);

  // Enter/exit replay: reset the base-layer look, and on entry fit the camera to
  // the filtered set so the whole map is in frame as it draws in. Reads data + filter
  // from propsRef so it depends only on the enter/exit signals — the current values are
  // always fresh, with no stale-closure trap and no refit on every unrelated filter tweak.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyPaint();
    const { data, filter } = propsRef.current;
    if (!replaying || !data) return;

    // Kick off playback once the camera settles (or right away if it doesn't move).
    const ready = () => propsRef.current.onReplayReady();

    const { types, from, to } = filter;
    const shown = (p: { type: string; ts: number }) =>
      (types.length === 0 || types.includes(p.type)) &&
      (from === undefined || p.ts >= from) &&
      (to === undefined || p.ts <= to);

    // Fit the densest cluster, not the raw extent, so an occasional trip abroad
    // doesn't zoom the home region down to a dot while it draws in.
    const shownFeatures = data.features.filter((f) => shown(f.properties));
    const box = densestClusterBounds(shownFeatures);
    const bounds = box && new mapboxgl.LngLatBounds([box[0], box[1]], [box[2], box[3]]);
    // Refinement centres tightly on the density peak; the cap keeps it a comfortable
    // regional view rather than zooming to street level.
    const camera = bounds
      ? map.cameraForBounds(bounds, { padding: FIT_PADDING, maxZoom: 11 })
      : null;
    if (!camera) {
      ready();
      return;
    }
    // Draw only after the pan lands, so routes don't animate mid-flight.
    map.once("moveend", ready);
    map.flyTo({
      ...camera,
      duration: 900,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
    return () => {
      map.off("moveend", ready);
    };
  }, [replaying, replayEpoch]);

  // Smoothly fly to + fit the whole selected track into the strip between the panels.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || selectedId == null || !data) return;
    const feature = data.features.find((f) => f.properties.id === selectedId);
    if (!feature) return;
    const bounds = new mapboxgl.LngLatBounds();
    for (const c of feature.geometry.coordinates) {
      bounds.extend(c as [number, number]);
    }
    if (bounds.isEmpty()) return;

    const camera = map.cameraForBounds(bounds, { padding: FIT_PADDING, maxZoom: 15 });
    if (!camera) return;
    // Always animate (user-requested), even under prefers-reduced-motion, via essential.
    // curve < 1.42 keeps the zoom-out arc gentle; easeOutCubic for a soft landing.
    map.flyTo({
      ...camera,
      duration: 1400,
      curve: 1.2,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
  }, [selectedId, data]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
