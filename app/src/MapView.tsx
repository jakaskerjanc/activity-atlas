// Owns the Mapbox GL map. Renders activity routes as a glow + core line pair in the
// Activity Atlas style, drives hover/selection highlighting, and plays a fade-in reveal
// (re-triggered by REPLAY). Which activities show is decided upstream (activityFilter.ts);
// this module only applies the expression it is handed. In the Grade color mode the
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
import type { ReplayFrame, ReplayStep } from "./replay";
import { densestClusterBounds, densestClusterRouteBounds, type Bounds } from "./cluster";
import { homeCamera, HOME_MAX_ZOOM } from "./homeCamera";
import { fitOffset, fitPadding, insetsKey, type Insets } from "./ui/layout";
import { nearestSample } from "./routeCursor";
import { activeTrackIds } from "./activeTracks";
import { formatDate, formatKm, typeLabel } from "./format";
import { typeColor } from "./colors";
import type { ActivityFeature, ActivityFeatureCollection, DetailFile, Theme } from "./types";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
/** Without a token mapboxgl.Map throws on construction and takes the whole app
 * down with it. Skip the map instead, so the panels and Analytics still work
 * (e.g. a fresh fork showing the demo data). Every effect below
 * already no-ops while mapRef is null. */
const HAS_TOKEN = Boolean(import.meta.env.VITE_MAPBOX_TOKEN);

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
// stay fully painted underneath. During replay these layers hold every route, and
// feature-state shows only the one drawing (DRAWING_STATE).
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
// Fit margin for the end labels, which sit beside their dots: about a long name's width.
const CITY_LABEL_ROOM = 90;
/** Non-selected routes while one is selected: a quiet grey, so the selection is unmistakable. */
const MUTED_ROUTE: Record<Theme, string> = { dark: "#6b6f7a", light: "#8b909b" };
const FADE_MS = 1200;

const NO_POINTS: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const NO_LINES: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Per-feature highlight gate. Toggling feature-state is cheap; swapping paint
 * expressions would force Mapbox to reload the whole source on every hover. */
const ACTIVE_STATE: ExpressionSpecification = ["boolean", ["feature-state", "active"], false];

/** Replay gates, also on feature-state, for the same reason. A filter change makes Mapbox
 * rebuild the source's tiles in a worker, so a filter-driven replay showed each route
 * transition late, while the paint (the trim) changed at once: a route that just finished
 * vanished until the rebuild caught up. Feature-state lands on the next frame, in step
 * with the trim. `pending`: a base route not yet drawn. `drawing`: the one route drawing. */
const PENDING_STATE: ExpressionSpecification = ["boolean", ["feature-state", "pending"], false];
const DRAWING_STATE: ExpressionSpecification = ["boolean", ["feature-state", "drawing"], false];

/** Matches nothing — parks the active layers when no route is drawing. */
const MATCH_NONE: ExpressionSpecification = ["==", ["get", "id"], ""];

/**
 * A city route end: a dot with the place's name beside it (styled in index.css), on the
 * side away from where the route leaves the dot, so the line never runs through it.
 */
function cityMarker(name: string, end: "origin" | "city", side: "left" | "right"): HTMLElement {
  const el = document.createElement("div");
  el.className = `city-marker city-marker--${end}`;
  const label = document.createElement("span");
  label.className = `city-marker__label city-marker__label--${side}`;
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
  /** The routes as grade runs, once the route profiles load; drawn in Grade mode. */
  grade: GradeRoutes | null;
  hoverId: string | null;
  /** The open route table's routes (inside the filter), highlighted together; null when closed. */
  groupIds: readonly string[] | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  /** True while replay owns the map; suspends hover/select highlighting + the plain filter. */
  replaying: boolean;
  /** Current replay frame (null when idle). Drives the completed/active split + trim. */
  replayFrame: ReplayFrame | null;
  /** The replay's routes in drawing order; a frame's index points into it. */
  replayTimeline: ReplayStep[];
  /** Signals replay just became active — used to fit the camera to the visible activities once. */
  replayEpoch: number;
  /** Bumped when a place is picked: fly to the densest cluster of the visible routes. */
  placeFlyEpoch: number;
  /** Called once the entry fit-to-cluster fly-to settles, so playback starts after the pan. */
  onReplayReady: () => void;
  /** Screen space the panels cover at each edge; fitted routes stay clear of it. */
  insets: Insets;
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
  /** Called as the routes start to fade in, so the route preview can fade out. */
  onRoutesShown?: () => void;
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

/** Where the map starts if the activities haven't arrived: Slovenia, centered on Ljubljana. */
const SLOVENIA_CENTER: [number, number] = [14.5058, 46.0569];
const SLOVENIA_ZOOM = 7.6;

/** What the route layers draw: grade runs or whole routes. */
function routesFor(p: Props): GeoJSON.FeatureCollection | null {
  if (p.colorMode === "grade" && p.grade) return p.grade.collection;
  return p.data;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function MapView(props: Props) {
  const { data, mapFilter, colorMode, colorDomain, hoverId, groupIds, selectedId } = props;
  const { replaying, replayFrame, replayEpoch } = props;
  const routeData = routesFor(props);

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

  // The ids whose `active` feature-state is set, so a change writes only the difference.
  const syncedActiveRef = useRef<ReadonlySet<string>>(new Set());
  // The drawing route whose line-gradient is set (null: none), so frames only rewrite
  // it when the route changes.
  const gradientKeyRef = useRef<string | null>(null);
  // True while the cursor was last set by the map, so map events never clear a
  // cursor the charts own.
  const mapOwnsCursorRef = useRef(false);
  // The city route's end markers (DOM overlays, so they survive a style swap).
  const cityMarkersRef = useRef<mapboxgl.Marker[]>([]);
  // The hover label (a DOM overlay positioned by hand, so a pointer move never re-renders).
  const tipRef = useRef<HTMLDivElement | null>(null);
  const tipIdRef = useRef<string | null>(null);
  // The opening view has been framed on the activities (once per data load).
  const framedRef = useRef(false);
  // Whether the base layers currently wear the muted selection color.
  const mutedRef = useRef<boolean | null>(null);
  // The replay state applyReplay last wrote to the map, so each frame writes only what
  // changed: the timeline whose routes carry `pending`, how many of them are done (no
  // longer pending), the route carrying `drawing`, and whether the active layers are live.
  const replayMapRef = useRef<{
    timeline: ReplayStep[] | null;
    done: number;
    drawingId: string | null;
    live: boolean;
  }>({ timeline: null, done: 0, drawingId: null, live: false });

  /** Single source of truth for the highlighted tracks (activeTrackIds): hover beats
   * an open route group, which beats the selection, and replay suspends highlighting.
   * Both the base-layer dimming and the feature-state highlight read this, so they can
   * never disagree. */
  function currentActiveIds(): string[] {
    return activeTrackIds(propsRef.current);
  }

  /** Fit padding for the current canvas + panel state. Recomputed at fit time so a
   * collapsed panel stops reserving room, and a narrow canvas clamps to fit. */
  function currentFitPadding(margin = 0) {
    const el = mapRef.current?.getContainer();
    if (!el) return { top: 0, bottom: 0, left: 0, right: 0 };
    return fitPadding(el.clientWidth, el.clientHeight, propsRef.current.insets, margin);
  }

  /**
   * The camera that fits `bounds` into the area the panels leave free. Mapbox spreads
   * padding evenly when it picks the center, so the offset moves the center into the
   * free area too (a route would otherwise sit half under the wider panel).
   */
  function cameraFor(bounds: mapboxgl.LngLatBounds, maxZoom: number, margin = 0) {
    const map = mapRef.current;
    if (!map || bounds.isEmpty()) return undefined;
    const padding = currentFitPadding(margin);
    // `offset` is read by cameraForBounds at runtime but missing from its CameraOptions type.
    const options = { padding, offset: fitOffset(padding), maxZoom } as Parameters<typeof map.cameraForBounds>[1];
    return map.cameraForBounds(bounds, options);
  }

  /** Frame the opening view on where the activities are: the home cluster's routes. */
  function frameHome() {
    const map = mapRef.current;
    const p = propsRef.current;
    if (!map || !loadedRef.current || framedRef.current || !p.data) return;
    framedRef.current = true;
    const box: Bounds | null = densestClusterRouteBounds(
      p.visible.length ? p.visible : p.data.features,
    );
    if (!box) return;
    const camera = cameraFor(new mapboxgl.LngLatBounds([box[0], box[1]], [box[2], box[3]]), HOME_MAX_ZOOM);
    if (camera) map.jumpTo(camera);
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
    const p = propsRef.current;
    const active = currentActiveIds().length > 0 || (!p.replaying && p.cityRoute != null);
    // A selection (or a shown city route) mutes the routes to grey, so the one that
    // matters stands apart; a mere hover only dims them.
    const selected = !p.replaying && (p.selectedId != null || p.cityRoute != null);
    // Heat mode drops the per-line opacity so overlapping corridors accumulate
    // toward full accent: how often you've been somewhere shows as brightness, not hue.
    const heat = p.colorMode === "heat";
    applyBaseColor(selected);
    map.setPaintProperty(GLOW_ID, "line-width", heat ? 5 : 6);
    map.setPaintProperty(CORE_ID, "line-width", heat ? 1.8 : 2.6);

    if (!active) {
      // In replay, routes not drawn yet stay hidden (see PENDING_STATE). The expression
      // is written once on entry: a data-driven value costs a relayout, so it never
      // changes per frame (Mapbox skips writes of an equal value).
      const hidePending = (v: number): number | ExpressionSpecification =>
        p.replaying ? ["case", PENDING_STATE, 0, v] : v;
      map.setPaintProperty(GLOW_ID, "line-opacity", hidePending((heat ? 0.14 : 0.2) * f));
      map.setPaintProperty(CORE_ID, "line-opacity", hidePending((heat ? 0.34 : 0.85) * f));
      return;
    }
    map.setPaintProperty(GLOW_ID, "line-opacity", 0);
    map.setPaintProperty(CORE_ID, "line-opacity", (selected ? 0.4 : 0.22) * f);
  }

  /** Base routes in their scale's colors, or all one muted grey behind a selection. */
  function applyBaseColor(muted: boolean) {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID) || mutedRef.current === muted) return;
    mutedRef.current = muted;
    const p = propsRef.current;
    const color = muted ? MUTED_ROUTE[p.theme] : lineColorExpression(p.colorMode, p.colorDomain, p.theme);
    map.setPaintProperty(GLOW_ID, "line-color", color);
    map.setPaintProperty(CORE_ID, "line-color", color);
  }

  /** Move the `active` feature-state to the highlighted tracks: off for the ids that
   * left, on for the ids that joined (all of them when forced). These are the only
   * writes a hover or a route table toggle triggers, and they never cause a source
   * relayout. */
  function syncFeatureState(force = false) {
    const map = mapRef.current;
    if (!map || !map.getSource(SOURCE_ID)) return;
    const next = new Set(currentActiveIds());
    const prev = syncedActiveRef.current;
    for (const id of prev) {
      if (!next.has(id)) map.setFeatureState({ source: SOURCE_ID, id }, { active: false });
    }
    for (const id of next) {
      if (force || !prev.has(id)) map.setFeatureState({ source: SOURCE_ID, id }, { active: true });
    }
    syncedActiveRef.current = next;
  }

  /** Set the data-driven line color for a mode; the core gains blur in heat mode. */
  function applyColor(mode: ColorMode, domain: ColorDomain) {
    const map = mapRef.current;
    if (!map || !map.getLayer(GLOW_ID)) return;
    const color = lineColorExpression(mode, domain, propsRef.current.theme);
    // The base layers' color follows the selection too (applyBaseColor); force a rewrite.
    mutedRef.current = null;
    applyBaseColor(!propsRef.current.replaying && (propsRef.current.selectedId != null || propsRef.current.cityRoute != null));
    map.setPaintProperty(CORE_ID, "line-blur", mode === "heat" ? 2 : 0);
    map.setPaintProperty(HOVER_GLOW_ID, "line-color", color);
    map.setPaintProperty(HOVER_CORE_ID, "line-color", color);
    // The drawing route follows the same color scale so it reads as one of the set.
    map.setPaintProperty(ACTIVE_GLOW_ID, "line-color", color);
    map.setPaintProperty(ACTIVE_CORE_ID, "line-color", color);
    // Grade runs meet end to end: round caps would overlap at every seam and bead the
    // translucent layers, so they butt instead (joins inside a run stay round). The
    // opaque hover core hides any overlap, so it keeps round caps.
    const cap = mode === "grade" ? "butt" : "round";
    for (const id of [GLOW_ID, CORE_ID, HOVER_GLOW_ID]) map.setLayoutProperty(id, "line-cap", cap);
    applyActiveGradient(propsRef.current.replayFrame);
  }

  /** In Grade mode, paint the drawing route with its runs' colors as a line-gradient
   * (it is one whole feature, so it has no per-run `grade` to read); otherwise clear it
   * so line-color applies. */
  function applyActiveGradient(frame: ReplayFrame | null) {
    const map = mapRef.current;
    if (!map || !map.getLayer(ACTIVE_GLOW_ID)) return;
    const p = propsRef.current;
    const stops = frame && p.colorMode === "grade" ? p.grade?.stops.get(frame.id) : undefined;
    const key = stops && frame ? frame.id : null;
    if (key === gradientKeyRef.current) return;
    gradientKeyRef.current = key;
    const gradient = stops ? lineGradient(stops) : undefined;
    map.setPaintProperty(ACTIVE_GLOW_ID, "line-gradient", gradient);
    map.setPaintProperty(ACTIVE_CORE_ID, "line-gradient", gradient);
  }

  /** Point the route source at the current routes: grade or density runs, or whole lines. */
  function applyRoutes() {
    const routes = routesFor(propsRef.current);
    const src = mapRef.current?.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    src?.setData(routes ?? NO_LINES);
  }

  /** Point the drawing-route source at the whole lines. */
  function applyActiveRoutes() {
    const src = mapRef.current?.getSource(ACTIVE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    src?.setData(propsRef.current.data ?? NO_LINES);
  }

  /**
   * Reflect a replay frame onto the map: the base layers show the completed routes
   * (the timeline before the drawing route), the active layers reveal just the
   * drawing route up to its trim. A null frame clears it all, leaving the base
   * layers on the plain user filter.
   *
   * Every per-frame change goes through feature-state or a constant paint value, both
   * applied on the next render. Filters change only on entry and exit: a filter change
   * rebuilds the source's tiles in a worker, which lags the trim (see PENDING_STATE).
   */
  function applyReplay(frame: ReplayFrame | null) {
    const map = mapRef.current;
    if (!map || !map.getLayer(ACTIVE_GLOW_ID)) return;
    const s = replayMapRef.current;

    applyActiveGradient(frame);

    // Mark the timeline's routes pending (a new timeline: entry, or a filter change
    // mid-replay), or clear the marks on exit.
    const timeline = frame ? propsRef.current.replayTimeline : null;
    if (s.timeline !== timeline) {
      for (const step of s.timeline ?? []) {
        map.removeFeatureState({ source: SOURCE_ID, id: step.id }, "pending");
      }
      for (const step of timeline ?? []) {
        map.setFeatureState({ source: SOURCE_ID, id: step.id }, { pending: true });
      }
      s.timeline = timeline;
      s.done = 0;
    }

    // Hand `drawing` to the route now drawing.
    const drawingId = frame?.id ?? null;
    if (s.drawingId !== drawingId) {
      if (s.drawingId != null) {
        map.removeFeatureState({ source: ACTIVE_SOURCE_ID, id: s.drawingId }, "drawing");
      }
      if (drawingId != null) {
        map.setFeatureState({ source: ACTIVE_SOURCE_ID, id: drawingId }, { drawing: true });
      }
      s.drawingId = drawingId;
    }

    // The active layers hold every route while replay runs (only `drawing` shows), and
    // are parked otherwise so they cost nothing.
    const live = frame != null;
    if (s.live !== live) {
      const filter = live ? null : MATCH_NONE;
      map.setFilter(ACTIVE_GLOW_ID, filter);
      map.setFilter(ACTIVE_CORE_ID, filter);
      s.live = live;
    }

    if (!frame || !timeline) return;

    // Routes before the drawing one are done; scrubbing back makes some pending again.
    const k = Math.min(frame.index, timeline.length);
    for (let i = s.done; i < k; i++) {
      map.setFeatureState({ source: SOURCE_ID, id: timeline[i].id }, { pending: false });
    }
    for (let i = k; i < s.done; i++) {
      map.setFeatureState({ source: SOURCE_ID, id: timeline[i].id }, { pending: true });
    }
    s.done = k;

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
    if (!route) {
      cityMarkersRef.current = [];
      return;
    }
    const first = route.coords[0];
    const last = route.coords[route.coords.length - 1];
    // Each label goes on the side facing away from the other end.
    const eastward = last[0] >= first[0];
    cityMarkersRef.current = [
      new mapboxgl.Marker({ element: cityMarker(route.originName, "origin", eastward ? "left" : "right") })
        .setLngLat(first)
        .addTo(map),
      new mapboxgl.Marker({ element: cityMarker(route.cityName, "city", eastward ? "right" : "left") })
        .setLngLat(last)
        .addTo(map),
    ];
  }

  /** Fly to the whole city route, clear of the panels. */
  function fitCityRoute() {
    const map = mapRef.current;
    const route = propsRef.current.cityRoute;
    if (!map || !route) return;
    const bounds = new mapboxgl.LngLatBounds();
    for (const c of route.coords) bounds.extend(c);
    const camera = cameraFor(bounds, 10, CITY_LABEL_ROOM);
    if (!camera) return;
    map.flyTo({
      ...camera,
      duration: 1600,
      curve: 1.2,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
  }

  /**
   * Name the activity under the pointer: a dot (the type's color in Type mode), the name,
   * then "Ride on <date> · <km> km", worded like the panel's subtitle.
   * Grade runs carry only the id, so the details come from `data`.
   */
  function showTip(id: string, x: number, y: number) {
    const map = mapRef.current;
    if (!map) return;
    let tip = tipRef.current;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "route-tip";
      tip.setAttribute("role", "tooltip");
      map.getContainer().append(tip);
      tipRef.current = tip;
    }
    if (tipIdRef.current !== id) {
      tipIdRef.current = id;
      const f = propsRef.current.data?.features.find((g) => g.properties.id === id);
      if (!f) return hideTip();
      const p = f.properties;
      const dist = p.distance != null ? ` · ${formatKm(p.distance)} km` : "";
      tip.replaceChildren();
      const name = document.createElement("div");
      name.className = "route-tip__name";
      const dot = document.createElement("span");
      dot.className = "route-tip__dot";
      // The type's color only where routes wear it; in the other modes the route's color
      // varies along it or with the data, so the dot keeps to the accent.
      dot.style.background =
        propsRef.current.colorMode === "type" ? typeColor(p.type, propsRef.current.theme) : ACCENT;
      const label = document.createElement("span");
      label.textContent = p.name;
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      name.append(dot, label);
      const meta = document.createElement("div");
      meta.className = "route-tip__meta";
      meta.textContent = `${typeLabel(p.type)} on ${formatDate(p.ts)}${dist}`;
      tip.append(name, meta);
    }
    // Beside the pointer, flipped to stay inside the map.
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = x + 16 + tw > w ? x - 16 - tw : x + 16;
    const top = y + 16 + th > h ? y - 12 - th : y + 16;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    tip.dataset.on = "true";
  }

  function hideTip() {
    tipIdRef.current = null;
    if (tipRef.current) tipRef.current.dataset.on = "false";
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
    propsRef.current.onRoutesShown?.();
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
        // Exposes each route's id to feature-state, which picks the one drawing.
        promoteId: "id",
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
    // Hover/select highlight layers — the active tracks (activeTrackIds), gated by feature-state.
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
          "line-opacity": ["case", DRAWING_STATE, 0.55, 0],
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
          "line-opacity": ["case", DRAWING_STATE, 1, 0],
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
        paint: { "circle-radius": 7.5, "circle-color": "#ffffff", "circle-opacity": 0.95, "circle-stroke-width": 1, "circle-stroke-color": "rgba(0,0,0,0.35)" },
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
    if (!HAS_TOKEN || !containerRef.current || mapRef.current) return;
    // Open on the home frame (App mounts the map once the routes are in, unless they
    // failed), so the first tiles fetched are the ones the view keeps, and they land
    // under the route preview. frameHome still runs on load, with Mapbox's own numbers.
    const el = containerRef.current;
    const p = propsRef.current;
    const home = p.data
      ? homeCamera(p.visible.length ? p.visible : p.data.features, el.clientWidth, el.clientHeight, p.insets)
      : null;
    const map = new mapboxgl.Map({
      container: el,
      style: STYLE_URL[p.theme],
      center: home?.center ?? SLOVENIA_CENTER,
      zoom: home?.zoom ?? SLOVENIA_ZOOM,
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
    appliedStyleRef.current = STYLE_URL[p.theme];
    // Dev only: lets screenshot scripts wait for the map to settle instead of sleeping.
    if (import.meta.env.DEV) (window as unknown as { __map?: mapboxgl.Map }).__map = map;

    map.on("load", () => {
      installLayers();
      loadedRef.current = true;

      if (propsRef.current.data) {
        applyRoutes();
        applyActiveRoutes();
        frameHome();
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
      if (id != null) {
        p.onHover(id);
        showTip(id, e.point.x, e.point.y);
      }
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
      hideTip();
      propsRef.current.onHover(null);
      releaseCursor();
    });
    map.on("mouseout", () => {
      releaseCursor();
      hideTip();
    });
    // A drag or zoom moves the map under a still pointer; don't leave a stale label.
    map.on("movestart", hideTip);

    // Click a track selects it; click on empty map deselects. Inert during replay.
    map.on("click", (e) => {
      if (propsRef.current.replaying) return;
      hideTip();
      const hits = map.queryRenderedFeatures(e.point, { layers: [GLOW_ID] });
      const id = hits[0]?.properties?.id as string | undefined;
      if (id != null) propsRef.current.onSelect(id);
      else propsRef.current.onDeselect();
    });

    return () => {
      tipRef.current?.remove();
      tipRef.current = null;
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
      mutedRef.current = null;
      syncedActiveRef.current = new Set();
      replayMapRef.current = { timeline: null, done: 0, drawingId: null, live: false };
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
    framedRef.current = false;
    frameHome();
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

  // Apply filter changes. Replay keeps the user filter on the base layers and hides
  // the routes it hasn't drawn yet through feature-state (applyReplay).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer(CORE_ID)) return;
    applyBaseFilter(map, mapFilter);
  }, [mapFilter]);

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
    if (replaying) hideTip();
  }, [hoverId, groupIds, selectedId, replaying]);

  // The muted selection grey and the type colors differ per theme.
  useEffect(() => {
    if (!loadedRef.current) return;
    applyColor(propsRef.current.colorMode, propsRef.current.colorDomain);
    applyPaint();
  }, [props.theme]);

  // Hand the active track to feature-state so the highlight layers follow it.
  useEffect(() => {
    if (!loadedRef.current) return;
    syncFeatureState();
  }, [hoverId, groupIds, selectedId, replaying]);

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
    applyPaint();
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
    const camera = bounds ? cameraFor(bounds, 11) : null;
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

  // A picked place: fly to where its routes cluster, with replay's easing. Clearing a
  // place doesn't bump the epoch, so the camera stays; nothing visible leaves it be too.
  // Reads `visible` from propsRef, as above: the epoch is the only trigger. While
  // replaying, replay drives the camera (and follows the new filter), so no fly.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || props.placeFlyEpoch === 0) return;
    if (propsRef.current.replaying) return;
    const box = densestClusterBounds(propsRef.current.visible);
    if (!box) return;
    const camera = cameraFor(new mapboxgl.LngLatBounds([box[0], box[1]], [box[2], box[3]]), 12);
    if (!camera) return;
    map.flyTo({
      ...camera,
      duration: 900,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
  }, [props.placeFlyEpoch]);

  // Smoothly fly to + fit the whole selected track into the area the panels leave free.
  // Refits when that area changes (the phone's sheet grows once the charts load, or is
  // opened), so the route never ends up under a panel.
  const fitKey = insetsKey(props.insets);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || selectedId == null || !data) return;
    const feature = data.features.find((f) => f.properties.id === selectedId);
    if (!feature) return;
    const bounds = new mapboxgl.LngLatBounds();
    for (const c of feature.geometry.coordinates) {
      bounds.extend(c as [number, number]);
    }
    const camera = cameraFor(bounds, 15);
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
  }, [selectedId, data, fitKey]);

  if (!HAS_TOKEN) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          textAlign: "center",
          color: "var(--text-muted)",
        }}
      >
        Map unavailable: set VITE_MAPBOX_TOKEN in .env (see the README).
      </div>
    );
  }
  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
