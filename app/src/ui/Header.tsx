// Top bar: TRACE / Activity Atlas wordmark. Overlays the map.

import { ACCENT, MONO } from "./theme";

export function Header() {
  return (
    <header
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 62,
        display: "flex",
        alignItems: "center",
        padding: "0 22px",
        zIndex: 30,
        background:
          "linear-gradient(180deg, rgba(10,11,15,.9), rgba(10,11,15,0))",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, pointerEvents: "auto" }}>
        <div
          style={{
            width: 13,
            height: 13,
            borderRadius: 3,
            background: ACCENT,
            boxShadow: `0 0 14px ${ACCENT}`,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: ".14em" }}>TRACE</span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 9.5,
              letterSpacing: ".22em",
              color: "#8b8f99",
              textTransform: "uppercase",
            }}
          >
            Activity Atlas
          </span>
        </div>
      </div>
    </header>
  );
}
