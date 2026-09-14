// Left panel: filter controls + color-mode selector. Activity/aggregate stats
// live in InfoPanel.

import type { CSSProperties } from "react";
import { GlassPanel } from "./GlassPanel";
import { FilterSection } from "./FilterSection";
import { ColorSection } from "./ColorSection";
import { useMediaQuery } from "./useMediaQuery";
import type { ColorMode, ColorDomain } from "../colors";
import type { Theme } from "../types";

// Matches the old `.side-panel` CSS hide. Below this width the controls do not fit, so
// the panel is dropped entirely — see the comment in SidePanel for why it must not be
// merely hidden.
const MOBILE_QUERY = "(max-width: 680px)";

interface Props {
  theme: Theme;
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
  // Unmount on narrow screens instead of hiding with CSS. Hiding keeps the element in
  // the tree but measures it 0x0, and liquid-glass-react's "shader" mode then throws
  // IndexSizeError building its displacement map (createImageData(0, 0)) — which took
  // the whole app down on phones.
  if (useMediaQuery(MOBILE_QUERY)) return null;

  return (
    <GlassPanel
      theme={p.theme}
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
