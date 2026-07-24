// Bottom-center transport for chronological replay: play/pause, a scrubbable
// progress track, the running date readout, and speed. Takes InfoPanel's slot
// while replay is active.

import type { CSSProperties } from "react";
import { MONO, eyebrow } from "./theme";
import { GlassPanel } from "./GlassPanel";
import { formatDateYear } from "../format";
import type { Theme } from "../types";

const SPEEDS = [0.5, 1, 2, 4];

interface Props {
  theme: Theme;
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
}

export function ReplayBar(p: Props) {
  return (
    <GlassPanel
      theme={p.theme}
      anchor={{ bottom: 24, centerX: true }}
      width={420}
      maxWidth="calc(100vw - 84px)"
      // >= the play button's 16px accent glow, which the glass would otherwise clip.
      insetX={18}
      insetY={18}
      gap={12}
    >
      <div style={topRow}>
        <span style={eyebrow}>Replay</span>
        <span style={dateStyle}>{p.dateTs == null ? "—" : formatDateYear(p.dateTs)}</span>
      </div>

      <div style={controlRow}>
        <button
          onClick={p.onPlayPause}
          aria-label={p.playing ? "Pause" : p.atEnd ? "Restart" : "Play"}
          style={playBtn}
        >
          {p.playing ? "❚❚" : p.atEnd ? "↻" : "▶"}
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
