// Owns the Mapbox GL map. Renders activity routes as a glow + core line pair in the
// Trace Atlas style, drives hover/selection highlighting, and plays a fade-in reveal
// (re-triggered by REPLAY). Filtering + the GeoJSON data contract are unchanged.

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { ExpressionSpecification } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { buildFilter, type FilterState } from "./filters";
import type { ActivityFeatureCollection } from "./types";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const SOURCE_ID = "activities";
const GLOW_ID = "activities-glow";
const CORE_ID = "activities-core";
const ACCENT = "#ff6b3d";
const FADE_MS = 1200;

interface Props {
  data: ActivityFeatureCollection | null;
  filter: FilterState;
  hoverId: number | null;
  selectedId: number | null;
  onHover: (id: number | null) => void;
  onSelect: (id: number) => void;
  onDeselect: () => void;
}

/** Padding that keeps a fitted track centered in the strip between the panels. */
const FIT_PADDING = { top: 90, bottom: 80, left: 330, right: 360 };

/** Fit the map viewport to the bounding box of all route coordinates. */
function fitToData(map: mapboxgl.Map, data: ActivityFeatureCollection) {
  const bounds = new mapboxgl.LngLatBounds();
  for (const f of data.features) {
    for (const c of f.geometry.coordinates) {
      bounds.extend(c as [number, number]);
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, duration: 0 });
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function MapView(props: Props) {
  const { data, filter, hoverId, selectedId } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const loadedRef = useRef(false);

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
    const active = activeRef.current;

    if (active == null) {
      map.setPaintProperty(GLOW_ID, "line-opacity", 0.2 * f);
      map.setPaintProperty(GLOW_ID, "line-width", 6);
      map.setPaintProperty(CORE_ID, "line-opacity", 0.82 * f);
      map.setPaintProperty(CORE_ID, "line-width", 2.6);
      return;
    }
    const match: ExpressionSpecification = ["==", ["get", "id"], active];
    map.setPaintProperty(GLOW_ID, "line-opacity", ["case", match, 0.5 * f, 0.05 * f]);
    map.setPaintProperty(GLOW_ID, "line-width", ["case", match, 10, 6]);
    map.setPaintProperty(CORE_ID, "line-opacity", ["case", match, 1 * f, 0.16 * f]);
    map.setPaintProperty(CORE_ID, "line-width", ["case", match, 4.6, 2.6]);
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
      const p = Math.min(1, (now - t0) / FADE_MS);
      fadeRef.current = 1 - Math.pow(1 - p, 3); // easeOutCubic
      applyPaint();
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [0, 20],
      zoom: 1.5,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
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
      map.addLayer({
        id: CORE_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ACCENT, "line-width": 2.6, "line-opacity": 0 },
      });
      map.setFilter(GLOW_ID, buildFilter(propsRef.current.filter));
      map.setFilter(CORE_ID, buildFilter(propsRef.current.filter));
      loadedRef.current = true;

      const d = propsRef.current.data;
      if (d) {
        (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource).setData(d);
        fitToData(map, d);
        startFade();
      }
    });

    // Hover highlighting (glow is the wider hit target).
    map.on("mousemove", GLOW_ID, (e) => {
      const id = e.features?.[0]?.properties?.id as number | undefined;
      map.getCanvas().style.cursor = "pointer";
      if (id != null) propsRef.current.onHover(id);
    });
    map.on("mouseleave", GLOW_ID, () => {
      map.getCanvas().style.cursor = "";
      propsRef.current.onHover(null);
    });

    // Click a track selects it; click on empty map deselects.
    map.on("click", (e) => {
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

  // Update source when data arrives/changes, then replay the reveal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !data) return;
    (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
    fitToData(map, data);
    startFade();
  }, [data]);

  // Apply filter changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer(CORE_ID)) return;
    const expr = buildFilter(filter);
    map.setFilter(GLOW_ID, expr);
    map.setFilter(CORE_ID, expr);
  }, [filter]);

  // Repaint highlight when the active track changes.
  useEffect(() => {
    applyPaint();
  }, [activeId]);

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
