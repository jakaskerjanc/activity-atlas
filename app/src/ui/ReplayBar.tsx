// Bottom-center transport for chronological replay: play/pause, a scrubbable
// progress track, the running date readout, and speed. Takes InfoPanel's slot
// while replay is active.

import type { CSSProperties } from "react";
import { MONO, eyebrow } from "./theme";
import { GlassPanel } from "./GlassPanel";
import { BOTTOM_PANEL_INSET_X, BOTTOM_PANEL_WIDTH } from "./layout";
import { formatDate } from "../format";

const SPEEDS = [0.5, 1, 2, 4];

interface Props {
  playing: boolean;
  progress: number; // 0..1
  /** epoch seconds of the drawing route, or null before the first frame. */
  dateTs: number | null;
  speed: number;
  atEnd: boolean;
  onPlayPause: () => void;
  onSeek: (progress: number) => void;
  onSpeed: (speed: number) => void;
  onExit: () => void;
  /** Collapsed off the bottom edge, leaving its title strip visible to click. */
  collapsed: boolean;
  onToggle: () => void;
}

export function ReplayBar(p: Props) {
  return (
    <GlassPanel
      anchor={{ bottom: 24, centerX: true }}
      width={BOTTOM_PANEL_WIDTH}
      maxWidth="calc(100vw - 84px)"
      // >= the play button's 16px accent glow, which the glass would otherwise clip.
      insetX={BOTTOM_PANEL_INSET_X}
      insetY={18}
      gap={12}
      collapsed={p.collapsed}
      onToggleCollapse={p.onToggle}
      collapseEdge="bottom"
      collapseLabel="replay controls"
    >
      <div style={topRow}>
        <span style={eyebrow}>Replay</span>
        <span style={dateStyle}>{p.dateTs == null ? "—" : formatDate(p.dateTs)}</span>
      </div>

      <div style={controlRow}>
        <button
          onClick={p.onPlayPause}
          aria-label={p.playing ? "Pause" : p.atEnd ? "Restart" : "Play"}
          style={playBtn}
        >
          <TransportIcon playing={p.playing} atEnd={p.atEnd} />
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(p.progress * 1000)}
          onChange={(e) => p.onSeek(+e.target.value / 1000)}
          style={{ flex: 1 }}
          aria-label="Replay progress"
        />
      </div>

      <div style={footRow}>
        <div style={{ display: "flex", gap: 6 }}>
          {SPEEDS.map((s) => (
            <button key={s} onClick={() => p.onSpeed(s)} style={pillStyle(s === p.speed)}>
              {s}×
            </button>
          ))}
        </div>
        <button onClick={p.onExit} style={exitBtn}>
          Exit
        </button>
      </div>
    </GlassPanel>
  );
}

// Transport glyphs as paths on a 24px grid. Text glyphs (▶/❚❚/↻) carried the font's
// own side bearings and baseline, so they never sat centered in the circle; these are
// optically centered and inherit the button's color via currentColor.
function TransportIcon({ playing, atEnd }: { playing: boolean; atEnd: boolean }) {
  if (playing) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z" />
      </svg>
    );
  }
  if (atEnd) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
      </svg>
    );
  }
  // The triangle's mass sits right of its box center, which reads as centered in a circle.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

const topRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
};

const dateStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 15,
  fontWeight: 600,
  color: "var(--accent-text)",
  letterSpacing: ".02em",
};

const controlRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
};

const playBtn: CSSProperties = {
  appearance: "none",
  border: "none",
  cursor: "pointer",
  flex: "0 0 auto",
  width: 38,
  height: 38,
  borderRadius: "50%",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 13,
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "0 0 16px var(--accent)",
};

const footRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

function pillStyle(on: boolean): CSSProperties {
  return {
    appearance: "none",
    border: on ? "1px solid var(--accent)" : "1px solid var(--control-border)",
    cursor: "pointer",
    padding: "4px 9px",
    borderRadius: 8,
    background: on ? "var(--accent-tint)" : "transparent",
    color: on ? "var(--pill-on-text)" : "var(--text-muted)",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 500,
    transition: "background .15s, border-color .15s",
  };
}

const exitBtn: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--control-border)",
  cursor: "pointer",
  padding: "4px 12px",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-soft)",
  fontSize: 12,
  fontWeight: 500,
};
