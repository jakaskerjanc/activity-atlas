// Floating panel chrome: a translucent, blurred box anchored to a fixed point in the
// map overlay. Material comes from the --panel-bg/--panel-border/--panel-blur tokens in
// index.css, which already flip with the light/dark theme.

import type { CSSProperties, ReactNode } from "react";

/**
 * Padding held on the outer box rather than the scroll container, so a scrollbar is not
 * jammed against the rounded rim. Only used when the panel actually scrolls: everywhere
 * else the whole inset lives inside the content box, where it doubles as bleed room for
 * things like accent glows.
 */
const GUTTER = 6;

// Clearance kept past the panel's right edge when it clamps via `avoidLeft`.
const AVOID_RIGHT_MARGIN = 24;

export type GlassAnchor =
  | { top: number; left: number }
  | {
      bottom: number;
      centerX: true;
      /**
       * Minimum left offset (px), for a bottom-center panel that must clear a fixed
       * element (e.g. SidePanel) instead of overlapping it when centered. When set, the
       * panel centers itself only in the space to the right of that offset, and its
       * width caps to fit there.
       */
      avoidLeft?: number;
    };

interface Props {
  anchor: GlassAnchor;
  /** Content width; the panel reads 2 * insetX wider. */
  width: number;
  /** Caps the *content* box; the panel reads 2 * insetX wider. */
  maxWidth?: string;
  /** Set only when the panel should scroll — that is what makes it a scroll container. */
  maxHeight?: string;
  /**
   * Distance from the panel edge to the content. Most of it sits inside the content
   * box, which is what keeps accent glows (`box-shadow: 0 0 Npx`) from being cut off:
   * the panel clips at its own edge, so anything painted beyond the inset disappears.
   * Keep these >= the largest glow inside the panel.
   */
  insetX?: number;
  insetY?: number;
  /** Column gap between children. */
  gap?: number;
  children: ReactNode;
}

export function GlassPanel(p: Props) {
  const { insetX = 16, insetY = 14 } = p;
  const scrolls = p.maxHeight != null;
  const pad = scrolls ? GUTTER : 0;
  const avoidLeft = "avoidLeft" in p.anchor ? p.anchor.avoidLeft : undefined;
  // When clamped, the box's own left offset already reserves the avoided space, so cap
  // content width to what's left of the viewport instead of the caller's maxWidth.
  const maxWidth =
    avoidLeft != null
      ? `calc(100vw - ${avoidLeft + 2 * insetX + AVOID_RIGHT_MARGIN}px)`
      : p.maxWidth;

  return (
    <div
      style={{
        position: "absolute",
        zIndex: 20,
        ...anchorStyle(p.anchor, p.width, insetX),
        borderRadius: 16,
        background: "var(--panel-bg)",
        border: "1px solid var(--panel-border)",
        backdropFilter: "var(--panel-blur)",
        WebkitBackdropFilter: "var(--panel-blur)",
        padding: pad,
      }}
    >
      <div
        className={scrolls ? "glass-scroll" : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          width: p.width,
          maxWidth,
          maxHeight: p.maxHeight,
          padding: `${insetY - pad}px ${insetX - pad}px`,
          gap: p.gap,
          // A vertical scroll container clips horizontally too, so only opt in when the
          // panel needs it — otherwise glows would be cut at the content edge instead of
          // bleeding into the inset.
          overflowY: scrolls ? "auto" : "visible",
          overflowX: scrolls ? "hidden" : "visible",
        }}
      >
        {p.children}
      </div>
    </div>
  );
}

function anchorStyle(anchor: GlassAnchor, width: number, insetX: number): CSSProperties {
  if ("bottom" in anchor) {
    if (anchor.avoidLeft != null) {
      const halfBox = width / 2 + insetX;
      return {
        bottom: anchor.bottom,
        left: `max(${anchor.avoidLeft}px, calc(50% - ${halfBox}px))`,
      };
    }
    return { bottom: anchor.bottom, left: "50%", transform: "translateX(-50%)" };
  }
  return { top: anchor.top, left: anchor.left };
}
