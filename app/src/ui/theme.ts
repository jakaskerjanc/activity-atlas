// Shared visual tokens + the floating "glass" panel styling from the Trace Atlas design.

import type { CSSProperties } from "react";

export const ACCENT = "#ff6b3d";
export const MONO = "'JetBrains Mono', monospace";

const panelBase: CSSProperties = {
  position: "absolute",
  zIndex: 20,
  display: "flex",
  flexDirection: "column",
  borderRadius: 14,
  padding: "18px 18px",
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,.09)",
  background: "rgba(14,15,20,.72)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 24px 60px rgba(0,0,0,.5)",
};

/** The single merged control + stats panel, sized to content, scrolls if tall. */
export const PANEL_STYLE: CSSProperties = {
  ...panelBase,
  top: 82,
  left: 24,
  width: 296,
  padding: "14px 16px",
  maxHeight: "calc(100% - 100px)",
  overflowY: "auto",
  overflowX: "hidden",
};

/** Thin horizontal divider between panel sections. */
export const divider: CSSProperties = {
  height: 1,
  background: "rgba(255,255,255,.08)",
  margin: "13px 0",
};

/** Small uppercase mono section eyebrow. */
export const eyebrow: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".2em",
  color: "#7e828d",
  textTransform: "uppercase",
};
