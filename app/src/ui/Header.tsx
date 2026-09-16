// Top bar: TRACE / Activity Atlas wordmark, plus the light/dark theme toggle.
// Overlays the map.

import type { CSSProperties } from "react";
import { MONO } from "./theme";
import type { Theme } from "../types";

const BTN = 38;
const HEADER_HEIGHT = 62;

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
}

export function Header({ theme, onToggleTheme }: Props) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: HEADER_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 22px",
        zIndex: 30,
        background:
          "linear-gradient(180deg, var(--header-fade), transparent)",
        pointerEvents: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, pointerEvents: "auto" }}>
        <div
          style={{
            width: 13,
            height: 13,
            borderRadius: 3,
            background: "var(--accent)",
            boxShadow: "0 0 14px var(--accent)",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: ".14em" }}>TRACE</span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 9.5,
              letterSpacing: ".22em",
              color: "var(--text-muted)",
              textTransform: "uppercase",
            }}
          >
            Activity Atlas
          </span>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: (HEADER_HEIGHT - BTN) / 2,
          right: 22,
          pointerEvents: "auto",
        }}
      >
        <button
          onClick={onToggleTheme}
          aria-label={`Switch to ${next} theme`}
          title={`Switch to ${next} theme`}
          style={toggleBtn}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}

const toggleBtn: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  width: BTN,
  height: BTN,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 12,
  border: "1px solid var(--panel-border)",
  background: "var(--panel-bg)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
  color: "var(--text)",
  transition: "color .35s ease",
};

function SunIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
