// Adapter around liquid-glass-react for the floating panels.
//
// The library is built for a pill that centers itself: it hard-applies
// `translate(-50%, -50%)` and overwrites any transform we pass, its inner box is an
// inline-flex row with a `font: 500 20px/1 system-ui` reset, and it cannot scroll.
// This component measures the content, feeds the library a pre-compensated anchor
// (see glassOffsets), and gives the content back its column layout, font and scrolling.

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import LiquidGlass from "liquid-glass-react";
import { glassOffsets, type GlassAnchor, type GlassSize } from "./glassOffsets";
import { glassMaterial } from "./theme";
import type { Theme } from "../types";

/**
 * Padding held on the glass rather than the content, so a scrollbar is not jammed
 * against the rounded rim. The scroll box — and therefore the full-height scrollbar —
 * is inset by this much, which at a 16px corner radius is enough for the bar to clear
 * the corner arc. Only used when the panel actually scrolls: everywhere else the whole
 * inset lives inside the content box, where it doubles as bleed room.
 */
const GUTTER = 6;

interface Props {
  anchor: GlassAnchor;
  /** Content width; the glass box is this plus `insetX` on each side. */
  width: number;
  /** Caps the *content* box; the glass reads 2 * insetX wider. */
  maxWidth?: string;
  /** Set only when the panel should scroll — that is what makes it a scroll container. */
  maxHeight?: string;
  /**
   * Distance from the glass edge to the content. Most of it sits inside the content
   * box, which is what keeps accent glows (`box-shadow: 0 0 Npx`) from being cut off:
   * the glass clips at its own edge, so anything painted beyond the inset disappears.
   * Keep these >= the largest glow inside the panel.
   */
  insetX?: number;
  insetY?: number;
  /** Column gap between children. */
  gap?: number;
  /** Passed through to the glass container, e.g. `.side-panel` for the mobile hide. */
  className?: string;
  theme: Theme;
  children: ReactNode;
}

export function GlassPanel(p: Props) {
  const { insetX = 16, insetY = 14 } = p;
  const scrolls = p.maxHeight != null;
  const glassPad = scrolls ? GUTTER : 0;
  const contentRef = useRef<HTMLDivElement>(null);
  // {0,0} until the first measurement; the panel stays hidden until then so it never
  // paints at the uncompensated anchor.
  const [size, setSize] = useState<GlassSize>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      // offsetWidth/Height, not getBoundingClientRect: layout size, unaffected by the
      // library's hover scale transform. Both already include the content padding.
      const next = { w: el.offsetWidth + glassPad * 2, h: el.offsetHeight + glassPad * 2 };
      setSize((prev) => {
        if (prev.w === next.w && prev.h === next.h) return prev;
        // The library only re-measures itself on window resize, so its displacement map
        // would keep the stale size when our content grows. Nudge it.
        queueMicrotask(() => window.dispatchEvent(new Event("resize")));
        return next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [glassPad]);

  const measured = size.w > 0 && size.h > 0;

  return (
    <LiquidGlass
      {...glassMaterial(p.theme)}
      cornerRadius={16}
      elasticity={0}
      padding={`${glassPad}px`}
      className={p.className}
      style={{
        position: "absolute",
        zIndex: 20,
        ...glassOffsets(p.anchor, size),
        visibility: measured ? "visible" : "hidden",
      }}
    >
      <div
        ref={contentRef}
        className={scrolls ? "glass-scroll" : undefined}
        style={{
          ...contentStyle,
          width: p.width,
          maxWidth: p.maxWidth,
          maxHeight: p.maxHeight,
          padding: `${insetY - glassPad}px ${insetX - glassPad}px`,
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
    </LiquidGlass>
  );
}

// Undoes the library's font reset and text shadow, and restores column layout.
// `inherit` is no use here — the value being inherited *is* the library's reset — so
// the body's typography is restated.
const contentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-ui)",
  fontSize: 16,
  fontWeight: 400,
  lineHeight: "normal",
  color: "var(--text)",
  textShadow: "none",
};
