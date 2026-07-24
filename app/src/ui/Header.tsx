// Top bar: TRACE / Activity Atlas wordmark, plus the light/dark theme toggle.
// Overlays the map.

import type { CSSProperties } from "react";
import LiquidGlass from "liquid-glass-react";
import { MONO, glassMaterial } from "./theme";
import type { Theme } from "../types";

const BTN = 38;
// The glass sits at top/left 0 of a zero-sized anchor and its own translate(-50%, -50%)
// centers it there, so the anchor marks the button's center: 22px inset from the right,
// vertically centered in the 62px header. It has to be top/left rather than `right`
// because the library's rim layers only read position/top/left — a `right` anchor
// strands them at their `left: 50%` default, adrift in the middle of the header.
const BTN_CENTER_TOP = 62 / 2;
const BTN_CENTER_RIGHT = 22 + BTN / 2;

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
        height: 62,
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

      {/* The click target stays a real <button> inside the glass: the library's own
          onClick lands on a div, with no keyboard or screen-reader affordance. */}
      <div
        style={{
          position: "absolute",
          top: BTN_CENTER_TOP,
          right: BTN_CENTER_RIGHT,
          width: 0,
          height: 0,
        }}
      >
        <LiquidGlass
          {...glassMaterial(theme)}
          cornerRadius={12}
          elasticity={0.3}
          padding="0"
          style={{
            position: "absolute",
            top: "0px",
            left: "0px",
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
        </LiquidGlass>
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
  border: "none",
  background: "transparent",
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
