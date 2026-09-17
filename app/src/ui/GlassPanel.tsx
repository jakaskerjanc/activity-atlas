// Floating panel chrome: a translucent, blurred box anchored to a fixed point in the
// map overlay. Material comes from the --panel-bg/--panel-border/--panel-blur tokens in
// index.css, which already flip with the light/dark theme.

import type { CSSProperties, ReactNode } from "react";
import { BOTTOM_PANEL_PEEK, PANEL_TAB_LONG, PANEL_TAB_SIZE } from "./layout";

/**
 * Padding held on the outer box rather than the scroll container, so a scrollbar is not
 * jammed against the rounded rim. Only used when the panel actually scrolls: everywhere
 * else the whole inset lives inside the content box, where it doubles as bleed room for
 * things like accent glows.
 */
const GUTTER = 6;

/** Screen edge a collapsible panel slides toward when hidden. */
export type PanelEdge = "left" | "bottom";

export type GlassAnchor =
  | { top: number; left: number }
  | { bottom: number; centerX: true };

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
  /**
   * Collapse the panel off its edge: a "left" panel hides completely (only its tab
   * remains), a "bottom" panel leaves its title strip peeking.
   */
  collapsed?: boolean;
  /** Renders the edge tab; when absent the panel is not collapsible. */
  onToggleCollapse?: () => void;
  /** Edge the panel hides toward. Defaults to "left". */
  collapseEdge?: PanelEdge;
  /** Noun used in the tab's label: "filters" -> "Collapse filters". */
  collapseLabel?: string;
  children: ReactNode;
}

export function GlassPanel(p: Props) {
  const { insetX = 16, insetY = 14 } = p;
  const scrolls = p.maxHeight != null;
  const pad = scrolls ? GUTTER : 0;
  const collapsible = p.onToggleCollapse != null;
  const collapsed = collapsible && p.collapsed === true;
  const edge = p.collapseEdge ?? "left";
  const label = p.collapseLabel ?? "panel";

  return (
    <div
      onClick={collapsed ? p.onToggleCollapse : undefined}
      style={{
        position: "absolute",
        zIndex: 20,
        ...anchorStyle(p.anchor),
        transform: panelTransform(p.anchor, edge, collapsed),
        transition: collapsible ? "transform .28s ease" : undefined,
        // The collapsed bottom panel keeps a title strip on screen; make that strip read
        // as the click target that expands it.
        cursor: collapsed ? "pointer" : undefined,
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
      {collapsible && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            p.onToggleCollapse?.();
          }}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          aria-expanded={collapsed}
          title={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          style={tabStyle(edge)}
        >
          <Chevron edge={edge} collapsed={collapsed} />
        </button>
      )}
    </div>
  );
}

function anchorStyle(anchor: GlassAnchor): CSSProperties {
  if ("bottom" in anchor) return { bottom: anchor.bottom, left: "50%" };
  return { top: anchor.top, left: anchor.left };
}

/**
 * Combines the anchor's own offset (a centered bottom panel shifts by -50% X) with the
 * collapse slide. Scaling to the element's own size avoids measuring it. A "left" panel
 * hides completely (its tab stays put against the screen edge); a "bottom" panel stops
 * with its title strip still peeking, so the current activity stays identifiable.
 */
function panelTransform(
  anchor: GlassAnchor,
  edge: PanelEdge,
  collapsed: boolean,
): string | undefined {
  const parts: string[] = [];
  if ("bottom" in anchor) parts.push("translateX(-50%)");
  if (collapsed) {
    parts.push(
      edge === "bottom"
        ? `translateY(calc(100% - ${BOTTOM_PANEL_PEEK}px))`
        : "translateX(-100%)",
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// The tab hangs off the panel's leading edge so that, once the panel has slid away, it
// lands flush against the screen edge and stays clickable.
function tabStyle(edge: PanelEdge): CSSProperties {
  const base: CSSProperties = {
    appearance: "none",
    position: "absolute",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: 0,
    border: "1px solid var(--panel-border)",
    background: "var(--panel-bg)",
    backdropFilter: "var(--panel-blur)",
    WebkitBackdropFilter: "var(--panel-blur)",
    color: "var(--text-soft)",
  };
  if (edge === "bottom") {
    return {
      ...base,
      top: -PANEL_TAB_SIZE,
      left: "50%",
      transform: "translateX(-50%)",
      width: PANEL_TAB_LONG,
      height: PANEL_TAB_SIZE,
      borderRadius: "10px 10px 0 0",
    };
  }
  return {
    ...base,
    left: "100%",
    top: 14,
    width: PANEL_TAB_SIZE,
    height: PANEL_TAB_LONG,
    borderRadius: "0 10px 10px 0",
  };
}

// One right-pointing chevron, rotated to point along the collapse/expand direction.
function Chevron({ edge, collapsed }: { edge: PanelEdge; collapsed: boolean }) {
  const deg = edge === "left" ? (collapsed ? 0 : 180) : collapsed ? -90 : 90;
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${deg}deg)`, transition: "transform .28s ease" }}
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
