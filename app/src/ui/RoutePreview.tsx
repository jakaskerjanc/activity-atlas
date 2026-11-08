// The routes, drawn as a plain image where the map is about to draw them, so the map
// page shows its content as soon as routes.json arrives instead of after the ~520 kB
// mapbox-gl chunk downloads and starts (seconds on a slow phone). Framed with the camera
// MapView opens on (homeCamera.ts), so the basemap fills in underneath it. It fades out
// as the map's own routes fade in. Without a token, or if the map fails, it stays put.
//
// An <img> of an SVG blob rather than inline SVG: one decoded image is cheaper to paint
// than hundreds of paths in the DOM, and the browser counts it as the page's main
// content (LCP) the way it counts a photo. It starts below the header: Chrome takes an
// image covering the whole viewport for a background and never counts it, and the
// header strip is chrome anyway.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { homeCamera, projector } from "../homeCamera";
import { ACCENT } from "../colors";
import type { Insets } from "./layout";
import type { ActivityFeature } from "../types";

/** The preview image's Element Timing name. */
const TIMING_ID = "route-preview";
/** Where Element Timing exists but never reports (it shouldn't), settle anyway. */
const SETTLE_FALLBACK_MS = 1000;
/** As long as the map's own reveal (MapView's FADE_MS), so the two cross-fade. */
const FADE_OUT_MS = 1200;
/** Drop route points closer than this to the last kept one, in px: detail the 2.6 px
 * line hides anyway, and every point costs parse and stroke time. */
const MIN_STEP_PX = 2;

interface Props {
  /** The routes the map will draw. */
  features: ActivityFeature[];
  /** The screen edges the panels cover, as the map's opening fit reads them. */
  insets: Insets;
  /** The map has drawn its routes: fade out, then unmount. */
  done: boolean;
  /** Called once the preview is on screen, or turned out to have nothing to show. */
  onSettled?: () => void;
}

export function RoutePreview({ features, insets, done, onSettled }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Mounted after the map already drew: nothing to bridge.
  const [gone, setGone] = useState(done);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const svg = useMemo(
    () => (size ? routesSvg(features, size.w, size.h, insets) : null),
    // The opening frame changes only with these; not with the insets object's identity.
    [features, size, insets.top, insets.right, insets.bottom, insets.left],
  );
  const url = useObjectUrl(svg?.markup ?? null);

  // Settle once: when the image is on screen, or as soon as it's clear there is none.
  // A big SVG can take a couple hundred ms to rasterize after it loads, so "loaded" is
  // not "shown". Element Timing reports the frame that showed it (Chromium); elsewhere,
  // the frame after it loaded will do.
  const settledRef = useRef(false);
  const settle = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettled?.();
  };
  useEffect(() => {
    if (gone || (size && !svg)) settle();
  }, [gone, size, svg]);
  const timed = elementTimingSupported();
  useEffect(() => {
    if (!url || !timed) return;
    const po = new PerformanceObserver((list) => {
      if (list.getEntries().some((e) => (e as ElementTiming).identifier === TIMING_ID)) settle();
    });
    po.observe({ type: "element", buffered: true });
    return () => po.disconnect();
  }, [url]);
  const onLoad = () => {
    if (timed) setTimeout(settle, SETTLE_FALLBACK_MS);
    // rAF runs before the frame that paints the image; the timeout, after it.
    else requestAnimationFrame(() => setTimeout(settle));
  };

  // Under reduced motion the map's routes appear at once, so the preview goes at once.
  useEffect(() => {
    if (done && reducedMotion()) setGone(true);
  }, [done]);

  if (gone) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      onTransitionEnd={() => done && setGone(true)}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        opacity: done ? 0 : 1,
        transition: `opacity ${FADE_OUT_MS}ms ease-out`,
      }}
    >
      {url && svg && (
        <img
          src={url}
          alt=""
          // Not in React's attribute types; a spread passes it through as is.
          {...{ elementtiming: TIMING_ID }}
          onLoad={onLoad}
          onError={settle}
          width={svg.width}
          height={svg.height}
          style={{ position: "absolute", left: 0, top: svg.top, display: "block" }}
        />
      )}
    </div>
  );
}

/** A blob: URL for the markup, revoked when it changes or the component goes. */
function useObjectUrl(svg: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!svg) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [svg]);
  return url;
}

/** The preview image: its markup, and where it sits in the map's box. */
export interface PreviewSvg {
  markup: string;
  top: number;
  width: number;
  height: number;
}

/**
 * The routes as one SVG document covering the map below the header, in the map's plain
 * look: a soft wide glow under a thin accent line. Null when there is nothing to frame.
 */
export function routesSvg(
  features: ActivityFeature[],
  width: number,
  height: number,
  insets: Insets,
): PreviewSvg | null {
  const top = Math.max(0, insets.top);
  if (width <= 0 || height - top <= 0) return null;
  const camera = homeCamera(features, width, height, insets);
  if (!camera) return null;
  const project = projector(camera, width, height);
  const minStep2 = MIN_STEP_PX * MIN_STEP_PX;
  const parts: string[] = [];
  for (const f of features) {
    const cs = f.geometry.coordinates;
    if (cs.length < 2) continue;
    let [lx, ly] = project(cs[0][0], cs[0][1]);
    let d = `M${lx.toFixed(1)} ${ly.toFixed(1)}`;
    for (let i = 1; i < cs.length; i++) {
      const [x, y] = project(cs[i][0], cs[i][1]);
      const last = i === cs.length - 1;
      if (!last && (x - lx) ** 2 + (y - ly) ** 2 < minStep2) continue;
      d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
      lx = x;
      ly = y;
    }
    parts.push(d);
  }
  if (parts.length === 0) return null;
  const d = parts.join("");
  const h = height - top;
  // The viewBox starts at the header's bottom, so map coordinates draw unchanged. The
  // path is written once and drawn twice (glow, then line) with <use>.
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${h}" viewBox="0 ${top} ${width} ${h}">` +
    `<defs><path id="r" d="${d}"/></defs>` +
    `<g fill="none" stroke="${ACCENT}" stroke-linecap="round" stroke-linejoin="round">` +
    `<use href="#r" xlink:href="#r" stroke-width="6" stroke-opacity="0.2"/>` +
    `<use href="#r" xlink:href="#r" stroke-width="2.6" stroke-opacity="0.85"/>` +
    `</g></svg>`;
  return { markup, top, width, height: h };
}

/** An Element Timing entry (not in TypeScript's DOM types). */
type ElementTiming = PerformanceEntry & { identifier?: string };

function elementTimingSupported(): boolean {
  return typeof PerformanceObserver !== "undefined" &&
    (PerformanceObserver.supportedEntryTypes ?? []).includes("element");
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
