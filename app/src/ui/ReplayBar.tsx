// The replay transport: play/pause, a scrubbable progress track, which activity is
// drawing (its date, name, and place in the run), and speed. Bottom-center on desktop,
// a bottom sheet on a phone. Takes the detail panel's place while replay is active.

import type { CSSProperties } from "react";
import { GlassPanel } from "./GlassPanel";
import { FS, MONO, pillStyle, secondaryButton } from "./theme";
import { CloseIcon, PauseIcon, PlayIcon, RestartIcon } from "./icons";
import { PANEL_BOTTOM, REPLAY_BAR_WIDTH, SHEET_MAX_WIDTH } from "./layout";
import { formatDate } from "../format";

const SPEEDS = [0.5, 1, 2, 4];

interface Props {
  playing: boolean;
  progress: number; // 0..1
  /** The activity drawing now, or null before the first frame. */
  current: { ts: number; name: string; index: number } | null;
  /** How many activities the replay draws. */
  total: number;
  speed: number;
  atEnd: boolean;
  onPlayPause: () => void;
  onSeek: (progress: number) => void;
  onSpeed: (speed: number) => void;
  onExit: () => void;
  /** The phone layout: a bottom sheet. */
  mobile?: boolean;
  /** Reports the bar's height, so a fitted map stays clear of it. */
  onHeight?: (height: number) => void;
}

export function ReplayBar(p: Props) {
  const placement: CSSProperties = p.mobile
    ? { left: 0, right: 0, bottom: 0, margin: "0 auto", maxWidth: SHEET_MAX_WIDTH }
    : {
        bottom: PANEL_BOTTOM,
        left: "50%",
        width: REPLAY_BAR_WIDTH,
        maxWidth: "calc(100% - 40px)",
        transform: "translateX(-50%)",
      };
  const n = p.current ? p.current.index + 1 : 0;
  const pct = `${(p.progress * 100).toFixed(2)}%`;
  return (
    <GlassPanel
      label="Replay"
      placement={placement}
      className={p.mobile ? "panel--sheet" : undefined}
      onHeight={p.onHeight}
      padding="16px 18px 16px"
    >
      <div style={topRow}>
        <button
          type="button"
          className="ctl-accent"
          onClick={p.onPlayPause}
          aria-label={p.playing ? "Pause" : p.atEnd ? "Replay again" : "Play"}
          title={p.playing ? "Pause" : p.atEnd ? "Replay again" : "Play"}
          style={playBtn}
        >
          {p.playing ? <PauseIcon size={16} /> : p.atEnd ? <RestartIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }} aria-live="off">
          <div style={dateStyle}>{p.current ? formatDate(p.current.ts) : "Starting…"}</div>
          <div style={nameStyle}>{p.current?.name ?? "Framing your activities"}</div>
        </div>
        <div style={countStyle} aria-label={`${n} of ${p.total} activities drawn`}>
          <span style={{ color: "var(--text-strong)" }}>{n.toLocaleString("en-US")}</span>
          <span style={{ color: "var(--text-muted)" }}> / {p.total.toLocaleString("en-US")}</span>
        </div>
      </div>

      <input
        type="range"
        className="range-scrub"
        min={0}
        max={1000}
        step={1}
        value={Math.round(p.progress * 1000)}
        onChange={(e) => p.onSeek(+e.target.value / 1000)}
        aria-label="Replay progress"
        aria-valuetext={p.current ? `${formatDate(p.current.ts)}, ${n} of ${p.total}` : undefined}
        style={{ display: "block", margin: "16px 0", ["--played" as string]: pct }}
      />

      <div style={footRow}>
        <div role="group" aria-label="Replay speed" style={{ display: "flex", gap: 6 }}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === p.speed ? undefined : "ctl"}
              aria-pressed={s === p.speed}
              onClick={() => p.onSpeed(s)}
              aria-label={`${s}× speed`}
              style={pillStyle(s === p.speed)}
            >
              <span style={multiplier}>
                <span style={capTrim}>{s}</span>
                <svg
                  width={7}
                  height={7}
                  viewBox="0 0 7 7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.2}
                  strokeLinecap="round"
                  aria-hidden
                  style={{ display: "block", flex: "none", overflow: "visible" }}
                >
                  <path d="M1 1l5 5M6 1L1 6" />
                </svg>
              </span>
            </button>
          ))}
        </div>
        <button type="button" className="ctl" onClick={p.onExit} style={secondaryButton}>
          <CloseIcon size={14} />
          <span style={capTrim}>Exit replay</span>
        </button>
      </div>
    </GlassPanel>
  );
}

/** Trims a label's box to its cap height, so a flex row centers the letters themselves
 *  (not the font's ascent/descent) against an icon. No-op where unsupported. */
const capTrim = { textBox: "trim-both cap alphabetic" } as CSSProperties;

const multiplier: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 2 };

const topRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const playBtn: CSSProperties = {
  appearance: "none",
  border: "none",
  cursor: "pointer",
  flex: "0 0 auto",
  width: 42,
  height: 42,
  borderRadius: "50%",
  background: "var(--accent)",
  color: "var(--accent-ink)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "0 0 18px rgba(255, 107, 61, 0.45)",
};

const dateStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.md + 1,
  fontWeight: 600,
  color: "var(--text-strong)",
  whiteSpace: "nowrap",
};

const nameStyle: CSSProperties = {
  marginTop: 2,
  fontSize: FS.sm,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const countStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.sm,
  whiteSpace: "nowrap",
};

const footRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
