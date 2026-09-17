// Left panel: filter controls + color-mode selector. Activity/aggregate stats
// live in InfoPanel.

import type { CSSProperties } from "react";
import { GlassPanel } from "./GlassPanel";
import { FilterSection } from "./FilterSection";
import { ColorSection } from "./ColorSection";
import { useMediaQuery } from "./useMediaQuery";
import type { ColorMode, ColorDomain } from "../colors";

// Matches the old `.side-panel` CSS hide. Below this width the controls do not fit, so
// the panel is dropped entirely.
export const MOBILE_QUERY = "(max-width: 680px)";

// SidePanel's right edge (anchor.left 24 + width 296 + 2 * insetX 18 = 356) plus a 24px
// gap. Bottom-center panels clear this via GlassPanel's `avoidLeft` so they never overlap
// SidePanel above the mobile breakpoint, where it is still rendered.
export const SIDE_PANEL_CLEARANCE = 380;

interface Props {
  availableTypes: string[];
  typeCounts: Record<string, number>;
  enabledTypes: Set<string>;
  onToggleType: (type: string) => void;
  tsMin: number;
  tsMax: number;
  from: number;
  to: number;
  onFromChange: (ts: number) => void;
  onToChange: (ts: number) => void;
  colorMode: ColorMode;
  colorDomain: ColorDomain;
  onColorModeChange: (mode: ColorMode) => void;
  /** Start chronological replay of the currently filtered set. */
  onStartReplay: () => void;
  /** False when the filter leaves nothing to replay. */
  canReplay: boolean;
}

export function SidePanel(p: Props) {
  if (useMediaQuery(MOBILE_QUERY)) return null;

  return (
    <GlassPanel
      anchor={{ top: 82, left: 24 }}
      width={296}
      // All the room between the 82px anchor and a 24px bottom margin, less the panel's
      // own 14px insets. At any ordinary window height the content fits and no scrollbar
      // appears; the cap only bites on a very short window, where scrolling beats
      // running off the bottom of the screen.
      maxHeight="calc(100vh - 134px)"
      // Leaves 12px inside the scroll box, clearing the type dots' 10px accent glow.
      insetX={18}
    >
      <FilterSection
        availableTypes={p.availableTypes}
        typeCounts={p.typeCounts}
        enabledTypes={p.enabledTypes}
        onToggleType={p.onToggleType}
        tsMin={p.tsMin}
        tsMax={p.tsMax}
        from={p.from}
        to={p.to}
        onFromChange={p.onFromChange}
        onToChange={p.onToChange}
      />
      <div style={{ height: 1, background: "var(--divider)", margin: "13px 0" }} />
      <ColorSection
        mode={p.colorMode}
        domain={p.colorDomain}
        onChange={p.onColorModeChange}
      />
      <div style={{ height: 1, background: "var(--divider)", margin: "13px 0" }} />
      <button
        onClick={p.onStartReplay}
        disabled={!p.canReplay}
        style={replayBtn(p.canReplay)}
      >
        ▶  Replay history
      </button>
    </GlassPanel>
  );
}

function replayBtn(enabled: boolean): CSSProperties {
  return {
    appearance: "none",
    cursor: enabled ? "pointer" : "not-allowed",
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: `1px solid ${enabled ? "var(--accent)" : "var(--control-border)"}`,
    background: enabled ? "var(--accent-tint)" : "transparent",
    color: enabled ? "var(--pill-on-text)" : "var(--text-faint)",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: ".02em",
  };
}
