// Floating panel chrome: a frosted, near-opaque box docked to the map overlay. Material,
// motion and the hidden state come from the .panel rules in index.css (theme tokens), so
// this component only places it and arranges a fixed header over a scrolling body.
//
// Two ways to get out of the map's way, both driven by the owner:
// - `collapsed` keeps the header and drops the body (an accordion; on a phone, the
//   bottom sheet's peek).
// - `hidden` slides the whole panel off its edge, fully, and takes it out of the tab
//   order (the filters panel; the header's Filters button brings it back).

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

interface Props {
  /** Accessible name of the panel region. */
  label: string;
  id?: string;
  /** Placement and size: top/left/right/bottom, width, maxHeight. */
  placement: CSSProperties;
  /** Extra classes, e.g. "panel--sheet" for the phone's bottom sheet. */
  className?: string;
  /** Always shown, above the body. */
  header?: ReactNode;
  /** The scrolling content. */
  children?: ReactNode;
  /** Show only the header. */
  collapsed?: boolean;
  /** Slid fully off-screen and inert. */
  hidden?: boolean;
  /** Body padding. */
  padding?: string;
  /** Called with the panel's rendered height whenever it changes. */
  onHeight?: (height: number) => void;
}

export function GlassPanel(p: Props) {
  const ref = useRef<HTMLElement>(null);
  const onHeight = useRef(p.onHeight);
  onHeight.current = p.onHeight;
  const measures = p.onHeight != null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !measures || typeof ResizeObserver === "undefined") return;
    const update = () => onHeight.current?.(el.getBoundingClientRect().height);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight.current?.(0);
    };
  }, [measures]);

  return (
    <section
      ref={ref}
      id={p.id}
      aria-label={p.label}
      className={p.className ? `panel ${p.className}` : "panel"}
      data-hidden={p.hidden ? "true" : undefined}
      inert={p.hidden || undefined}
      style={p.placement}
    >
      {p.header}
      {!p.collapsed && p.children != null && (
        <div className="panel__body glass-scroll" style={{ padding: p.padding ?? "0 18px 18px" }}>
          {p.children}
        </div>
      )}
    </section>
  );
}
