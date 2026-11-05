// Owns the Mapbox GL map. Renders activity routes as a glow + core line pair in the
// Activity Atlas style, drives hover/selection highlighting, and plays a fade-in reveal
// (re-triggered by REPLAY). Which activities show is decided upstream (activityFilter.ts);
// this module only applies the expression it is handed. In the Elevation color mode the
// routes are drawn as grade runs (grade.ts) instead of whole lines. A distance
// comparison's city route, when shown, is drawn dashed on top with its two ends labelled.

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import type { ExpressionSpecification, FilterSpecification } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  ACCENT,
  lineColorExpression,
  type ColorMode,
  type ColorDomain,
} from "./colors";
import { lineGradient, type GradeRoutes } from "./grade";
import type { ReplayFrame } from "./replay";
import { densestClusterBounds } from "./cluster";
import { fitOffset, fitPadding } from "./ui/layout";
import { nearestSample } from "./routeCursor";
import type { ActivityFeature, ActivityFeatureCollection, DetailFile, Theme } from "./types";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

/** Base map that reads well under each theme's panels. Light uses the toned streets
 * style (roads/parks/water) so the translucent liquid-glass panels have real color
 * to refract; dark stays the muted dark base. */
const STYLE_URL: Record<Theme, string> = {
  dark: "mapbox://styles/mapbox/dark-v11",
  light: "mapbox://styles/jkyy/cmrxclplz00ji01qk9apa184q",
};

const SOURCE_ID = "activities";
// Whole routes for the drawing route in replay: line-trim-offset trims each feature on
// its own, so the drawing route must be one feature even while SOURCE_ID holds runs.
const ACTIVE_SOURCE_ID = "activities-active";
const GLOW_ID = "activities-glow";
const CORE_ID = "activities-core";
// The single route currently drawing in replay gets its own layers (and source) on top,
// so line-trim-offset (a per-layer paint prop) reveals just it while completed routes
// stay fully painted underneath.
const ACTIVE_GLOW_ID = "activities-active-glow";
const ACTIVE_CORE_ID = "activities-active-core";
const HOVER_GLOW_ID = "activities-hover-glow";
const HOVER_CORE_ID = "activities-hover-core";
// The chart/map cursor (#17): a ringed dot on the selected route at the hovered sample.
const CURSOR_SOURCE_ID = "activity-cursor";
const CURSOR_RING_ID = "activity-cursor-ring";
const CURSOR_DOT_ID = "activity-cursor-dot";
// A comparison city's route: a dashed line over a casing, in the theme's strongest ink so
// it reads apart from the activities in every color mode.
const CITY_SOURCE_ID = "city-route";
const CITY_CASING_ID = "city-route-casing";
const CITY_LINE_ID = "city-route-line";
const CITY_INK: Record<Theme, { line: string; casing: string }> = {
  dark: { line: "#ffffff", casing: "rgba(14, 15, 19, 0.75)" },
  light: { line: "#1c1c1e", casing: "rgba(255, 255, 255, 0.9)" },
};
// Fit margin for the end labels, which sit centered above their dots: about half a long
// name's width, and more than a label's height.
const CITY_LABEL_ROOM = 70;
const FADE_MS = 1200;

const NO_POINTS: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const NO_LINES: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Per-feature highlight gate. Toggling feature-state is cheap; swapping paint
 * expressions would force Mapbox to reload the whole source on every hover. */
const ACTIVE_STATE: ExpressionSpecification = ["boolean", ["feature-state", "active"], false];

/** Matches nothing — parks the active layers when no route is drawing. */
const MATCH_NONE: ExpressionSpecification = ["==", ["get", "id"], ""];

/** A city route end: a dot with the place's name beside it (styled in index.css). */
function cityMarker(name: string, end: "origin" | "city"): HTMLElement {
  const el = document.createElement("div");
  el.className = `city-marker city-marker--${end}`;
  const label = document.createElement("span");
  label.className = "city-marker__label";
  label.textContent = name;
  el.append(label);
  return el;
}

/** Point the four base route layers (glow, core, and their hover twins) at one filter. */
function applyBaseFilter(map: mapboxgl.Map, expr: FilterSpecification | null) {
  map.setFilter(GLOW_ID, expr);
  map.setFilter(CORE_ID, expr);
  map.setFilter(HOVER_GLOW_ID, expr);
  map.setFilter(HOVER_CORE_ID, expr);
}

interface Props {
  /** Selects the Mapbox base style; the panels themselves are themed in CSS. */
  theme: Theme;
  data: ActivityFeatureCollection | null;
  /** The activity filter as a Mapbox expression; null before data loads (draw all). */
  mapFilter: FilterSpecification | null;
  /** The activities that pass the filter; the replay camera fits to these. */
  visible: ActivityFeature[];
  colorMode: ColorMode;
  colorDomain: ColorDomain;
  /** The routes as grade runs, once the route profiles load; drawn in Elevation mode. */
  grade: GradeRoutes | null;
  hoverId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  /** True while replay owns the map; suspends hover/select highlighting + the plain filter. */
  replaying: boolean;
  /** Current replay frame (null when idle). Drives the completed/active split + trim. */
  replayFrame: ReplayFrame | null;
  /** Signals replay just became active — used to fit the camera to the visible activities once. */
  replayEpoch: number;
  /** Called once the entry fit-to-cluster fly-to settles, so playback starts after the pan. */
  onReplayReady: () => void;
  /** Reserves room for the left panel when fitting a track; false when it is collapsed. */
  sidePanelExpanded: boolean;
  /** [lng, lat] of the cursor sample, or null (no cursor, or no position there). */
  cursorPoint: [number, number] | null;
  /** The selected activity's samples, once loaded; enables route hover -> cursor. */
  selectedDetail: DetailFile | null;
  /** Set (or clear) the cursor from a pointer over the selected route. */
  onCursor: (i: number | null) => void;
  /** A distance comparison's route to its city, or null. */
  cityRoute: CityRouteLine | null;
  /** Bumped each time a city route is asked for, so asking again refits the camera. */
  cityRouteEpoch: number;
}

/** A comparison city's route, as the map draws it. */
export interface CityRouteLine {
  /** Changes when a different city or group is shown. */
  key: string;
  /** [lng, lat], from the origin to the city */
  coords: [number, number][];
  originName: string;
  cityName: string;
}

/** Home view on initial load: Slovenia, centered on Ljubljana. */
const SLOVENIA_CENTER: [number, number] = [14.5058, 46.0569];
const SLOVENIA_ZOOM = 7.6;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function MapView(props: Props) {
  const { data, mapFilter, colorMode, colorDomain, hoverId, selectedId } = props;
  const { replaying, replayFrame, replayEpoch } = props;
  // What the route layers draw: grade runs in Elevation mode (once loaded), else whole routes.
  const routeData = colorMode === "elevation" && props.grade ? props.grade.collection : data;

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

  const syncedActiveRef = useRef<string | null>(null);
  // The drawing route whose line-gradient is set (null: none), so frames only rewrite
  // it when the route changes.
  const gradientKeyRef = useRef<string | null>(null);
  // True while the cursor was last set by the map, so map events never clear a
  // cursor the charts own.
  const mapOwnsCursorRef = useRef(false);
  // The city route's end markers (DOM overlays, so they survive a style swap).
  const cityMarkersRef = useRef<mapboxgl.Marker[]>([]);

  /** Single source of truth for the highlighted track: hover beats selection, and
   * replay suspends highlighting. Both the base-layer dimming and the feature-state
   * highlight read this, so they can never disagree. */
  function currentActiveId(): string | null {
    const p = propsRef.current;
    return p.replaying ? null : (p.hoverId ?? p.selectedId);
  }

  /** Fit padding for the current canvas + panel state. Recomputed at fit time so a
   * collapsed side panel stops reserving room, and a narrow canvas clamps to fit. */
  function currentFitPadding(margin = 0) {
    const el = mapRef.current?.getContainer();
    if (!el) return { top: 0, bottom: 0, left: 0, right: 0 };
    return fitPadding(el.clientWidth, el.clientHeight, propsRef.current.sidePanelExpanded, margin);
  }

  /** Repaint the base layers for the current active presence + fade factor. The
   * active track itself is drawn by the feature-state-gated hover layers, so these
   * stay plain constants (constant -> constant writes never trigger a relayout). */
  function applyPaint() {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID)) return;
    const f = fadeRef.current;
    // In replay the base layers carry the accumulated (completed) routes at their
    // resting look — hover/select highlighting and the fade are both suspended.
    const active = currentActiveId() != null;
    // Heat mode drops the per-line opacity so overlapping corridors accumulate
    // toward full accent — density, not hue, carries the signal.
    const heat = propsRef.current.colorMode === "heat";
    const glowW = heat ? 5 : 6;
    const coreW = heat ? 1.8 : 2.6;

    if (!active) {
      map.setPaintProperty(GLOW_ID, "line-opacity", (heat ? 0.14 : 0.2) * f);
      map.setPaintProperty(GLOW_ID, "line-width", glowW);
      map.setPaintProperty(CORE_ID, "line-opacity", (heat ? 0.34 : 0.82) * f);
      map.setPaintProperty(CORE_ID, "line-width", coreW);
      return;
    }
    map.setPaintProperty(GLOW_ID, "line-opacity", (heat ? 0.04 : 0.05) * f);
    map.setPaintProperty(GLOW_ID, "line-width", glowW);
    map.setPaintProperty(CORE_ID, "line-opacity", (heat ? 0.1 : 0.16) * f);
    map.setPaintProperty(CORE_ID, "line-width", coreW);
  }

  /** Move the `active` feature-state to the hovered/selected track. This is the
   * only write a hover triggers, and it never causes a source relayout. */
  function syncFeatureState(force = false) {
    const map = mapRef.current;
    if (!map || !map.getSource(SOURCE_ID)) return;
    const next = currentActiveId();
    const prev = syncedActiveRef.current;
    if (!force && prev === next) return;
    if (prev != null && prev !== next) {
      map.setFeatureState({ source: SOURCE_ID, id: prev }, { active: false });
    }
    if (next != null) {
      map.setFeatureState({ source: SOURCE_ID, id: next }, { active: true });
    }
    syncedActiveRef.current = next;
  }

  /** Set the data-driven line color for a mode; core gains blur in heat mode. */
  function applyColor(mode: ColorMode, domain: ColorDomain) {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID)) return;
    const color = lineColorExpression(mode, domain);
    map.setPaintProperty(GLOW_ID, "line-color", color);
    map.setPaintProperty(CORE_ID, "line-color", color);
    map.setPaintProperty(CORE_ID, "line-blur", mode === "heat" ? 2 : 0);
    map.setPaintProperty(HOVER_GLOW_ID, "line-color", color);
    map.setPaintProperty(HOVER_CORE_ID, "line-color", color);
    // The drawing route follows the same color scale so it reads as one of the set.
    map.setPaintProperty(ACTIVE_GLOW_ID, "line-color", color);
    map.setPaintProperty(ACTIVE_CORE_ID, "line-color", color);
    // Grade runs meet end to end: round caps would overlap at every seam and bead the
    // translucent layers, so they butt instead (joins inside a run stay round). The
    // opaque hover core hides any overlap, so it keeps round caps.
    const cap = mode === "elevation" ? "butt" : "round";
    for (const id of [GLOW_ID, CORE_ID, HOVER_GLOW_ID]) map.setLayoutProperty(id, "line-cap", cap);
    applyActiveGradient(propsRef.current.replayFrame);
  }

  /** In Elevation mode, paint the drawing route with its runs' colors as a line-gradient
   * (it is one whole feature, so it has no per-run `grade` to read); otherwise clear it
   * so line-color applies. */
  function applyActiveGradient(frame: ReplayFrame | null) {
    const map = mapRef.current;
    if (!map || !map.getLayer(ACTIVE_GLOW_ID)) return;
    const p = propsRef.current;
    const stops = frame && p.colorMode === "elevation" ? p.grade?.stops.get(frame.id) : undefined;
    const key = stops && frame ? frame.id : null;
    if (key === gradientKeyRef.current) return;
    gradientKeyRef.current = key;
    const gradient = stops ? lineGradient(stops) : undefined;
    map.setPaintProperty(ACTIVE_GLOW_ID, "line-gradient", gradient);
    map.setPaintProperty(ACTIVE_CORE_ID, "line-gradient", gradient);
  }

  /** Point the route source at the current routes: grade runs or whole lines. */
  function applyRoutes() {
    const p = propsRef.current;
    const routes = p.colorMode === "elevation" && p.grade ? p.grade.collection : p.data;
    const src = mapRef.current?.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    src?.setData(routes ?? NO_LINES);
  }

  /** Point the drawing-route source at the whole lines. */
  function applyActiveRoutes() {
    const src = mapRef.current?.getSource(ACTIVE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    src?.setData(propsRef.current.data ?? NO_LINES);
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

    applyActiveGradient(frame);
    if (!frame) {
      map.setFilter(ACTIVE_GLOW_ID, MATCH_NONE);
      map.setFilter(ACTIVE_CORE_ID, MATCH_NONE);
      applyBaseFilter(map, propsRef.current.mapFilter);
      return;
    }

    const user = propsRef.current.mapFilter;
    // "Before the drawing route" in the exact order buildTimeline uses: ts, then
    // id (string) as the lexicographic tiebreak — must match buildTimeline's sort.
    // Keying on the pair (not ts alone) keeps same-second activities from
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

  /** Show the cursor dot at cursorPoint; hidden while replaying. */
  function applyCursor() {
    const map = mapRef.current;
    const src = map?.getSource(CURSOR_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    const { cursorPoint, replaying } = propsRef.current;
    src.setData(
      cursorPoint && !replaying
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: cursorPoint } },
            ],
          }
        : NO_POINTS,
    );
  }

  /** Draw the city route (or nothing) and move its end markers. */
  function applyCityRoute() {
    const map = mapRef.current;
    const src = map?.getSource(CITY_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (!map || !src) return;
    const route = propsRef.current.cityRoute;
    src.setData(
      route
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.coords } },
            ],
          }
        : NO_LINES,
    );
    for (const m of cityMarkersRef.current) m.remove();
    cityMarkersRef.current = route
      ? [
          new mapboxgl.Marker({ element: cityMarker(route.originName, "origin") })
            .setLngLat(route.coords[0])
            .addTo(map),
          new mapboxgl.Marker({ element: cityMarker(route.cityName, "city") })
            .setLngLat(route.coords[route.coords.length - 1])
            .addTo(map),
        ]
      : [];
  }

  /** Fly to the whole city route, clear of the panels. */
  function fitCityRoute() {
    const map = mapRef.current;
    const route = propsRef.current.cityRoute;
    if (!map || !route) return;
    const bounds = new mapboxgl.LngLatBounds();
    for (const c of route.coords) bounds.extend(c);
    const padding = currentFitPadding(CITY_LABEL_ROOM);
    const camera = map.cameraForBounds(bounds, { padding, maxZoom: 10 });
    if (!camera) return;
    map.flyTo({
      ...camera,
      // A long route is wide enough that centering it on the canvas would tuck its
      // start under the side panel.
      offset: fitOffset(padding),
      duration: 1600,
      curve: 1.2,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
  }

  /** Clear the cursor if the map set it (pointer left the selected route). */
  function releaseCursor() {
    if (!mapOwnsCursorRef.current) return;
    mapOwnsCursorRef.current = false;
    propsRef.current.onCursor(null);
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
        data: NO_LINES,
        // Exposes each feature's string id to feature-state (hover/select highlight).
        // Grade runs share their activity's id, so one write highlights the whole route.
        promoteId: "id",
      });
    }
    if (!map.getSource(ACTIVE_SOURCE_ID)) {
      map.addSource(ACTIVE_SOURCE_ID, {
        type: "geojson",
        data: NO_LINES,
        // Required for line-trim-offset (the replay draw-on reveal) and line-gradient.
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
    // Hover/select highlight layers — one feature at a time, gated by feature-state.
    if (!map.getLayer(HOVER_GLOW_ID)) {
      map.addLayer({
        id: HOVER_GLOW_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ACCENT,
          "line-width": 10,
          "line-opacity": ["case", ACTIVE_STATE, 0.5, 0],
          "line-blur": 8,
        },
      });
    }
    if (!map.getLayer(HOVER_CORE_ID)) {
      map.addLayer({
        id: HOVER_CORE_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ACCENT,
          "line-width": 4.6,
          "line-opacity": ["case", ACTIVE_STATE, 1, 0],
        },
      });
    }
    // Active (drawing) route layers — on top, parked until replay runs.
    if (!map.getLayer(ACTIVE_GLOW_ID)) {
      map.addLayer({
        id: ACTIVE_GLOW_ID,
        type: "line",
        source: ACTIVE_SOURCE_ID,
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
        source: ACTIVE_SOURCE_ID,
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
    // City route — over the activities, under the cursor.
    if (!map.getSource(CITY_SOURCE_ID)) {
      map.addSource(CITY_SOURCE_ID, { type: "geojson", data: NO_LINES });
    }
    const ink = CITY_INK[propsRef.current.theme];
    if (!map.getLayer(CITY_CASING_ID)) {
      map.addLayer({
        id: CITY_CASING_ID,
        type: "line",
        source: CITY_SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ink.casing, "line-width": 6 },
      });
    }
    if (!map.getLayer(CITY_LINE_ID)) {
      map.addLayer({
        id: CITY_LINE_ID,
        type: "line",
        source: CITY_SOURCE_ID,
        layout: { "line-join": "round" },
        paint: { "line-color": ink.line, "line-width": 2.4, "line-dasharray": [2, 1.6] },
      });
    }
    // Cursor marker — topmost: a light ring under an accent dot.
    if (!map.getSource(CURSOR_SOURCE_ID)) {
      map.addSource(CURSOR_SOURCE_ID, { type: "geojson", data: NO_POINTS });
    }
    if (!map.getLayer(CURSOR_RING_ID)) {
      map.addLayer({
        id: CURSOR_RING_ID,
        type: "circle",
        source: CURSOR_SOURCE_ID,
        paint: { "circle-radius": 7, "circle-color": "#ffffff", "circle-opacity": 0.95 },
      });
    }
    if (!map.getLayer(CURSOR_DOT_ID)) {
      map.addLayer({
        id: CURSOR_DOT_ID,
        type: "circle",
        source: CURSOR_SOURCE_ID,
        paint: { "circle-radius": 4.5, "circle-color": ACCENT },
      });
    }
    applyBaseFilter(map, propsRef.current.mapFilter);
    // A rebuilt layer starts with no line-gradient, whatever was last set.
    gradientKeyRef.current = null;
    applyColor(propsRef.current.colorMode, propsRef.current.colorDomain);
    applyCursor();
    applyCityRoute();
  }

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: STYLE_URL[propsRef.current.theme],
      center: SLOVENIA_CENTER,
      zoom: SLOVENIA_ZOOM,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    // The options above only stop mouse drag / touch pitch. Two-finger pinch and
    // Shift+arrows still rotate and pitch, so switch those off explicitly; this keeps
    // the camera 2D without disabling pinch zoom or keyboard pan/zoom.
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;
    appliedStyleRef.current = STYLE_URL[propsRef.current.theme];

    map.on("load", () => {
      installLayers();
      loadedRef.current = true;

      if (propsRef.current.data) {
        // Map is already constructed at the home view; no jumpTo needed here.
        applyRoutes();
        applyActiveRoutes();
        startFade();
      }
      // A city route asked for before the map was ready.
      fitCityRoute();
    });

    // Hover highlighting (glow is the wider hit target). Suspended during replay.
    // Over the selected route (once its samples are loaded) it also drives the cursor.
    map.on("mousemove", GLOW_ID, (e) => {
      const p = propsRef.current;
      if (p.replaying) return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      map.getCanvas().style.cursor = "pointer";
      if (id != null) p.onHover(id);
      const onSelected = e.features?.some((f) => f.properties?.id === p.selectedId) ?? false;
      const i = onSelected && p.selectedDetail ? nearestSample(p.selectedDetail, e.lngLat.lng, e.lngLat.lat) : null;
      if (i != null) {
        mapOwnsCursorRef.current = true;
        p.onCursor(i);
      } else {
        releaseCursor();
      }
    });
    map.on("mouseleave", GLOW_ID, () => {
      map.getCanvas().style.cursor = "";
      propsRef.current.onHover(null);
      releaseCursor();
    });
    map.on("mouseout", releaseCursor);

    // Click a track selects it; click on empty map deselects. Inert during replay.
    map.on("click", (e) => {
      if (propsRef.current.replaying) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: [GLOW_ID] });
      const id = hits[0]?.properties?.id as string | undefined;
      if (id != null) propsRef.current.onSelect(id);
      else propsRef.current.onDeselect();
    });

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      for (const m of cityMarkersRef.current) m.remove();
      cityMarkersRef.current = [];
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
      applyRoutes();
      applyActiveRoutes();
      syncedActiveRef.current = null;
      syncFeatureState(true);
      fadeRef.current = 1;
      if (propsRef.current.replaying) applyReplay(propsRef.current.replayFrame);
      applyPaint();
      applyCursor();
    });
    map.setStyle(url);
  }, [props.theme]);

  // Update the drawing-route source when data arrives/changes, then replay the reveal.
  // The route source follows routeData (below), which changes with data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !data) return;
    applyActiveRoutes();
    map.jumpTo({ center: SLOVENIA_CENTER, zoom: SLOVENIA_ZOOM });
    startFade();
  }, [data]);

  // Swap whole routes for grade runs (and back) as the color mode or the runs change.
  // New features start without feature-state, so the highlight is written again.
  useEffect(() => {
    if (!loadedRef.current || !routeData) return;
    applyRoutes();
    syncFeatureState(true);
    applyActiveGradient(propsRef.current.replayFrame);
  }, [routeData]);

  // Apply filter changes. Skipped while replaying — applyReplay owns the base
  // layers' filter then (it folds the current filter into the completed set).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer(CORE_ID)) return;
    if (replaying) return;
    applyBaseFilter(map, mapFilter);
  }, [mapFilter, replaying]);

  // Recolor when the color mode or its value domain changes. applyPaint follows
  // so heat mode's dimmed base opacities take effect immediately.
  useEffect(() => {
    if (!loadedRef.current) return;
    applyColor(colorMode, colorDomain);
    applyPaint();
  }, [colorMode, colorDomain]);

  // Repaint base layers when the active presence changes.
  useEffect(() => {
    applyPaint();
  }, [hoverId, selectedId, replaying]);

  // Hand the active track to feature-state so the highlight layers follow it.
  useEffect(() => {
    if (!loadedRef.current) return;
    syncFeatureState();
  }, [hoverId, selectedId, replaying]);

  // Move (or hide) the cursor marker.
  useEffect(() => {
    if (!loadedRef.current) return;
    applyCursor();
  }, [props.cursorPoint, replaying]);

  // Draw a newly shown city route (or take it down) and bring all of it into view. Asking
  // for the same route again (a new epoch) refits, in case the map was moved since.
  useEffect(() => {
    if (!loadedRef.current) return;
    applyCityRoute();
    fitCityRoute();
  }, [props.cityRoute?.key, props.cityRouteEpoch]);

  // A new selection starts with no map-owned cursor.
  useEffect(() => {
    mapOwnsCursorRef.current = false;
  }, [selectedId]);

  // Reflect each replay frame (also restores the base filter when it goes null).
  useEffect(() => {
    if (!loadedRef.current) return;
    applyReplay(replayFrame);
  }, [replayFrame]);

  // Enter/exit replay: reset the base-layer look, and on entry fit the camera to
  // the visible activities so the whole map is in frame as it draws in. Reads them
  // from propsRef so it depends only on the enter/exit signals — the current values are
  // always fresh, with no stale-closure trap and no refit on every unrelated filter tweak.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyPaint();
    const { visible } = propsRef.current;
    if (!replaying) return;

    // Kick off playback once the camera settles (or right away if it doesn't move).
    const ready = () => propsRef.current.onReplayReady();

    // Fit the densest cluster, not the raw extent, so an occasional trip abroad
    // doesn't zoom the home region down to a dot while it draws in.
    const box = densestClusterBounds(visible);
    const bounds = box && new mapboxgl.LngLatBounds([box[0], box[1]], [box[2], box[3]]);
    // Refinement centres tightly on the density peak; the cap keeps it a comfortable
    // regional view rather than zooming to street level.
    const camera = bounds
      ? map.cameraForBounds(bounds, {
          padding: currentFitPadding(),
          maxZoom: 11,
        })
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

    const camera = map.cameraForBounds(bounds, {
      padding: currentFitPadding(),
      maxZoom: 15,
    });
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
