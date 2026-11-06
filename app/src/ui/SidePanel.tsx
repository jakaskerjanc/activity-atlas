// The filters panel: the activity filter (types + date range), and on the map the route
// coloring and replay. Docked top-left on desktop; on a phone it opens over the map from
// the header's Filters button. Collapsing slides it fully off-screen, so no sliver of
// clipped controls is left behind; the header's Filters button brings it back.

import { useEffect, useRef, type CSSProperties } from "react";
import { GlassPanel } from "./GlassPanel";
import { PanelHeader } from "./PanelHeader";
import { FilterSection } from "./FilterSection";
import { ColorSection } from "./ColorSection";
import { ChevronIcon, CloseIcon, PlayIcon } from "./icons";
import { FS, R } from "./theme";
import { HEADER_HEIGHT, PANEL_EDGE, PANEL_TOP, SIDE_PANEL_WIDTH } from "./layout";
import type { ColorMode, ColorDomain } from "../colors";
import type { ActivityFilter } from "../activityFilter";
import type { Theme } from "../types";

// The last kind of input, so focus is only moved for keyboard users.
let lastInput: "key" | "pointer" = "pointer";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (lastInput = "key"), true);
  window.addEventListener("pointerdown", () => (lastInput = "pointer"), true);
}

interface Props {
  filter: ActivityFilter;
  onFilterChange: (filter: ActivityFilter) => void;
  /** How many activities pass the filter, for the panel's subtitle. */
  shownCount: number;
  colorMode: ColorMode;
  colorDomain: ColorDomain;
  onColorModeChange: (mode: ColorMode) => void;
  theme: Theme;
  /** Start chronological replay of the visible activities. */
  onStartReplay: () => void;
  /** False when the filter leaves nothing to replay. */
  canReplay: boolean;
  /** Show the map-only sections (coloring, replay). False on the analytics page. */
  showMapControls: boolean;
  /** Slid off-screen; the header's Filters button opens it again. */
  collapsed: boolean;
  onToggle: () => void;
  /** The phone layout: an overlay under the header instead of a docked panel. */
  mobile?: boolean;
  /** On the analytics page: its sections, listed as jump links under the filter. */
  sections?: { id: string; label: string }[];
}

export function SidePanel(p: Props) {
  const total = p.filter.activities.length;
  // Hiding the panel while focus is inside it would drop focus on the floor; hand it to
  // the header's Filters button, which opens the panel again.
  const wasCollapsed = useRef(p.collapsed);
  // Only for keyboard users: after a mouse close the button would otherwise wear a focus
  // ring nobody asked for.
  useEffect(() => {
    if (p.collapsed && !wasCollapsed.current && lastInput === "key") {
      const panel = document.getElementById("filters-panel");
      if (panel?.contains(document.activeElement) || document.activeElement === document.body) {
        document.getElementById("filters-toggle")?.focus({ preventScroll: true });
      }
    }
    wasCollapsed.current = p.collapsed;
  }, [p.collapsed]);
  const placement: CSSProperties = p.mobile
    ? {
        top: HEADER_HEIGHT + 2,
        left: 10,
        width: "min(420px, calc(100% - 20px))",
        maxHeight: `calc(100% - ${HEADER_HEIGHT + 12}px)`,
        zIndex: 25,
      }
    : {
        top: PANEL_TOP,
        left: PANEL_EDGE,
        width: SIDE_PANEL_WIDTH,
        maxHeight: `calc(100% - ${PANEL_TOP + PANEL_EDGE}px)`,
      };
  return (
    <GlassPanel
      id="filters-panel"
      label="Filters"
      placement={placement}
      hidden={p.collapsed}
      header={
        <PanelHeader
          title="Filters"
          subtitle={shownLine(p.shownCount, total)}
          action={{
            label: p.mobile ? "Close filters" : "Hide filters",
            icon: p.mobile ? <CloseIcon /> : <ChevronIcon dir="left" />,
            onClick: p.onToggle,
            expanded: !p.collapsed,
            controls: "filters-panel",
          }}
        />
      }
    >
      <FilterSection filter={p.filter} onChange={p.onFilterChange} colorMode={p.colorMode} theme={p.theme} />
      {p.sections && p.sections.length > 0 && (
        <>
          <hr style={divider} />
          <h3 style={{ ...sectionLabelStyle, marginBottom: 6 }}>On this page</h3>
          <nav aria-label="Analytics sections" style={{ display: "grid", gap: 1 }}>
            {p.sections.map((s) => (
              <a
                key={s.id}
                href={`#analytics`}
                className="ctl"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  if (p.mobile) p.onToggle();
                }}
                style={jumpLink}
              >
                {s.label}
              </a>
            ))}
          </nav>
        </>
      )}
      {p.showMapControls && (
        <>
          <hr style={divider} />
          <ColorSection
            mode={p.colorMode}
            domain={p.colorDomain}
            theme={p.theme}
            onChange={p.onColorModeChange}
          />
          <hr style={divider} />
          <button
            type="button"
            className="ctl-accent"
            onClick={p.onStartReplay}
            disabled={!p.canReplay}
            style={replayBtn(p.canReplay)}
          >
            <PlayIcon size={14} />
            Replay history
          </button>
          <p style={replayHint}>
            {p.canReplay
              ? "Draws the shown activities in the order you recorded them."
              : "Nothing to replay: no shown activity has a route."}
          </p>
        </>
      )}
    </GlassPanel>
  );
}

/** "All 531 activities shown", or "446 shown, 85 filtered out". */
export function shownLine(shown: number, total: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return shown === total ? `All ${n(total)} activities shown` : `${n(shown)} shown, ${n(total - shown)} filtered out`;
}

const sectionLabelStyle: CSSProperties = {
  margin: 0,
  fontSize: FS.xs + 1,
  fontWeight: 600,
  color: "var(--text-soft)",
};

const jumpLink: CSSProperties = {
  display: "block",
  padding: "7px 10px",
  borderRadius: R.sm,
  fontSize: FS.sm + 0.5,
  color: "var(--text)",
};

const divider: CSSProperties = {
  border: 0,
  height: 1,
  background: "var(--divider)",
  margin: "16px 0",
};

function replayBtn(enabled: boolean): CSSProperties {
  return {
    appearance: "none",
    cursor: enabled ? "pointer" : "not-allowed",
    width: "100%",
    height: 38,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: R.sm,
    border: `1px solid ${enabled ? "var(--accent)" : "var(--control-border)"}`,
    background: enabled ? "var(--accent-tint)" : "transparent",
    color: enabled ? "var(--pill-on-text)" : "var(--text-faint)",
    fontFamily: "inherit",
    fontSize: FS.sm + 0.5,
    fontWeight: 600,
  };
}

const replayHint: CSSProperties = {
  margin: "8px 0 0",
  fontSize: FS.xs + 0.5,
  lineHeight: 1.4,
  color: "var(--text-muted)",
  textAlign: "center",
};
