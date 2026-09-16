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

export type GlassAnchor = { top: number; left: number } | { bottom: number; centerX: true };

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

  return (
    <div
      style={{
        position: "absolute",
        zIndex: 20,
        ...anchorStyle(p.anchor),
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
          maxWidth: p.maxWidth,
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

function anchorStyle(anchor: GlassAnchor): CSSProperties {
  if ("bottom" in anchor) {
    return { bottom: anchor.bottom, left: "50%", transform: "translateX(-50%)" };
  }
  return { top: anchor.top, left: anchor.left };
}
