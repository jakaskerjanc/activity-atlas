// Top bar: the Activity Atlas wordmark, the Filters toggle, the Map / Analytics page
// switch, and the light/dark theme toggle. Overlays both pages: over the map it fades
// into the map; over the scrolling analytics page it is opaque, so content never runs
// under the wordmark.

import type { ComponentType, CSSProperties } from "react";
import { FS, R } from "./theme";
import { ChartIcon, FiltersIcon, MapIcon, MoonIcon, SunIcon } from "./icons";
import { HEADER_HEIGHT } from "./layout";
import type { Theme } from "../types";
import type { View } from "./useView";

const BTN = 36;

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  view: View;
  onViewChange: (view: View) => void;
  /** The filters panel's state, for the Filters toggle; omitted before data loads. */
  filtersOpen?: boolean;
  onToggleFilters?: () => void;
}

export function Header({ theme, onToggleTheme, view, onViewChange, filtersOpen, onToggleFilters }: Props) {
  const next = theme === "dark" ? "light" : "dark";
  const solid = view === "analytics";
  return (
    <header
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: HEADER_HEIGHT,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 16px 0 20px",
        zIndex: 30,
        background: solid ? "var(--bg)" : "linear-gradient(180deg, var(--header-fade), transparent)",
        // A hairline under the opaque bar only; over the map the fade has no edge.
        boxShadow: solid ? "0 1px 0 var(--divider)" : "none",
        pointerEvents: solid ? "auto" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, pointerEvents: "auto", minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: 12,
            height: 12,
            flex: "0 0 auto",
            borderRadius: 3,
            background: "var(--accent)",
            boxShadow: "0 0 12px var(--accent)",
          }}
        />
        <span
          className="wordmark"
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            lineHeight: 1.15,
            whiteSpace: "nowrap",
            color: "var(--text-strong)",
          }}
        >
          Activity Atlas
        </span>
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
        {onToggleFilters && (
          <button
            type="button"
            className="ctl"
            id="filters-toggle"
            onClick={onToggleFilters}
            aria-expanded={filtersOpen}
            aria-controls="filters-panel"
            aria-label="Filters"
            title={filtersOpen ? "Hide filters" : "Show filters"}
            style={{ ...chromeBtn, padding: "0 12px" }}
          >
            <FiltersIcon size={15} />
            <span className="header-btn-label">Filters</span>
          </button>
        )}
        <ViewSwitch view={view} onChange={onViewChange} />
        <button
          type="button"
          className="ctl"
          onClick={onToggleTheme}
          aria-label={`Switch to ${next} theme`}
          title={`Switch to ${next} theme`}
          style={{ ...chromeBtn, width: BTN, padding: 0 }}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}

const chromeBtn: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  height: BTN,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  boxSizing: "border-box",
  borderRadius: R.md,
  border: "1px solid var(--panel-border)",
  background: "var(--panel-bg)",
  boxShadow: "var(--panel-shadow)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
  color: "var(--text)",
  fontSize: FS.sm + 0.5,
  fontWeight: 600,
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
            className={on ? undefined : "ctl"}
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
  display: "flex",
  gap: 2,
  height: BTN,
  boxSizing: "border-box",
  padding: 3,
  borderRadius: R.md,
  background: "var(--panel-bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "var(--panel-shadow)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
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
    background: on ? "var(--accent)" : "transparent",
    color: on ? "var(--accent-ink)" : "var(--text-muted)",
    fontFamily: "inherit",
    fontSize: FS.sm + 0.5,
    fontWeight: 600,
  };
}
