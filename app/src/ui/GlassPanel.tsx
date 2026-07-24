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

const PAD_X = 16;
const PAD_Y = 14;

interface Props {
  anchor: GlassAnchor;
  /** Content width; the glass box is this plus horizontal padding. */
  width: number;
  /** Caps the *content* box; the glass reads 2 * PAD_X wider. */
  maxWidth?: string;
  maxHeight?: string;
  /** Column gap between children. */
  gap?: number;
  /** Passed through to the glass container, e.g. `.side-panel` for the mobile hide. */
  className?: string;
  theme: Theme;
  children: ReactNode;
}

export function GlassPanel(p: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  // {0,0} until the first measurement; the panel stays hidden until then so it never
  // paints at the uncompensated anchor.
  const [size, setSize] = useState<GlassSize>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      // offsetWidth/Height, not getBoundingClientRect: layout size, unaffected by the
      // library's hover scale transform.
      const next = { w: el.offsetWidth + PAD_X * 2, h: el.offsetHeight + PAD_Y * 2 };
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
  }, []);

  const measured = size.w > 0 && size.h > 0;

  return (
    <LiquidGlass
      {...glassMaterial(p.theme)}
      cornerRadius={16}
      elasticity={0}
      padding={`${PAD_Y}px ${PAD_X}px`}
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
        style={{
          ...contentStyle,
          width: p.width,
          maxWidth: p.maxWidth,
          maxHeight: p.maxHeight,
          gap: p.gap,
        }}
      >
        {p.children}
      </div>
    </LiquidGlass>
  );
}

// Undoes the library's font reset and text shadow, and restores column layout +
// scrolling (its own box is overflow: hidden). `inherit` is no use here — the value
// being inherited *is* the library's reset — so the body's typography is restated.
const contentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-ui)",
  fontSize: 16,
  fontWeight: 400,
  lineHeight: "normal",
  color: "var(--text)",
  textShadow: "none",
  overflowY: "auto",
  overflowX: "hidden",
};
