// Top bar: the Activity Atlas wordmark, the Map / Analytics page switch, and the
// light/dark theme toggle. Overlays both pages.

import type { ComponentType, CSSProperties } from "react";
import { glass } from "./theme";
import type { Theme } from "../types";
import type { View } from "./useView";

const BTN = 38;
const HEADER_HEIGHT = 62;

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  view: View;
  onViewChange: (view: View) => void;
}

export function Header({ theme, onToggleTheme, view, onViewChange }: Props) {
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
        <span
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            lineHeight: 1.15,
          }}
        >
          Activity Atlas
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          top: (HEADER_HEIGHT - BTN) / 2,
          right: 22,
          display: "flex",
          gap: 8,
          pointerEvents: "auto",
        }}
      >
        <ViewSwitch view={view} onChange={onViewChange} />
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

const VIEWS: { view: View; label: string; Icon: ComponentType }[] = [
  { view: "map", label: "Map", Icon: MapIcon },
  { view: "analytics", label: "Analytics", Icon: ChartIcon },
];

// Segmented control for the two pages. On a phone the labels drop (see
// .view-switch-label in index.css) and the aria-labels carry the names.
function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    <nav aria-label="Pages" style={switchBox}>
      {VIEWS.map(({ view: v, label, Icon }) => {
        const on = v === view;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            aria-label={label}
            title={label}
            onClick={() => onChange(v)}
            style={switchBtn(on)}
          >
            <Icon />
            <span className="view-switch-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

const switchBox: CSSProperties = {
  ...glass,
  display: "flex",
  gap: 2,
  height: BTN,
  boxSizing: "border-box",
  padding: 3,
  borderRadius: 12,
};

function switchBtn(on: boolean): CSSProperties {
  return {
    appearance: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 11px",
    border: 0,
    borderRadius: 9,
    background: on ? "var(--accent-tint)" : "transparent",
    boxShadow: on ? "inset 0 0 0 1px var(--accent)" : "none",
    color: on ? "var(--pill-on-text)" : "var(--text-muted)",
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: ".02em",
    transition: "color .2s ease, background .2s ease",
  };
}

function MapIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4zM9 4v13.5M15 6.5V20" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />
    </svg>
  );
}

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
