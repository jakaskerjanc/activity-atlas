// Active hours: two 24-hour clocks side by side, weekdays and weekends, of the time out
// in each local hour, midnight at the top, running clockwise. Each hour is a ring
// sector growing outward from the dial, its length linear in the time out and scaled
// to that clock's busiest hour (the clocks compare when in the day, not how much),
// over a faint full-length track that is also its hover target.

import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO } from "./theme";
import { formatDuration } from "../format";
import { busiestHour, type ActiveHours, type WeekSplit } from "../activeHours";

const SIZE = 300;
const C = SIZE / 2;
/** Inner radius (the dial's edge) and outer radius (a full-length bar). */
const R0 = 50;
const R1 = 146;
/** Half the angular gap between neighbouring sectors, in radians. */
const GAP = 0.012;

const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

function point(angle: number, r: number): [number, number] {
  return [C + r * Math.sin(angle), C - r * Math.cos(angle)];
}

/** The ring sector of hour h between radii ra and rb. */
export function sector(h: number, ra: number, rb: number): string {
  const a0 = (h / 24) * 2 * Math.PI + GAP;
  const a1 = ((h + 1) / 24) * 2 * Math.PI - GAP;
  const [x0, y0] = point(a0, ra);
  const [x1, y1] = point(a1, ra);
  const [x2, y2] = point(a1, rb);
  const [x3, y3] = point(a0, rb);
  const f = (n: number) => n.toFixed(2);
  return `M${f(x0)},${f(y0)}A${ra},${ra} 0 0 1 ${f(x1)},${f(y1)}L${f(x2)},${f(y2)}A${rb},${rb} 0 0 0 ${f(x3)},${f(y3)}Z`;
}

interface Hover {
  hour: number;
  x: number;
  y: number;
}

/** Weekdays and weekends side by side, and a note for activities neither could place. */
export function ActiveHoursClocks({ split }: { split: WeekSplit }) {
  return (
    <>
      <div style={layout}>
        <ActiveHoursClock label="Weekdays" hours={split.weekdays} />
        <ActiveHoursClock label="Weekends" hours={split.weekends} />
      </div>
      {split.skipped > 0 && (
        <p style={footnote}>
          {split.skipped} {split.skipped === 1 ? "activity" : "activities"} without a start time or duration{" "}
          {split.skipped === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
    </>
  );
}

export function ActiveHoursClock({ label, hours }: { label: string; hours: ActiveHours }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const max = Math.max(...hours.seconds);
  const busiest = busiestHour(hours);

  const track = (e: PointerEvent<SVGSVGElement>) => {
    const target = e.target as Element;
    const h = target.getAttribute("data-h");
    const box = boxRef.current?.getBoundingClientRect();
    if (h == null || !box) return;
    const r = target.getBoundingClientRect();
    setHover({ hour: Number(h), x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top });
  };

  return (
    <figure style={figure}>
      <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width="100%"
          role="img"
          aria-label={
            busiest == null
              ? `${label}: no time out`
              : `${label}: time out in each hour of the day; busiest ${hh(busiest)}–${hh(busiest + 1)}, ${formatDuration(hours.seconds[busiest])}`
          }
          onPointerMove={track}
          onPointerDown={track}
          style={{ display: "block" }}
        >
          {hours.seconds.map((_, h) => (
            <path key={`t${h}`} data-h={h} d={sector(h, R0, R1)} style={trackStyle} />
          ))}
          {hours.seconds.map((s, h) =>
            s > 0 && max > 0 ? (
              <path key={`b${h}`} d={sector(h, R0, R0 + (R1 - R0) * (s / max))} style={bar} />
            ) : null,
          )}
          {hover && <path d={sector(hover.hour, R0, R1)} style={outline} />}
          <circle cx={C} cy={C} r={R0 - 6} style={dial} />
          {Array.from({ length: 24 }, (_, h) => {
            const a = (h / 24) * 2 * Math.PI;
            const major = h % 6 === 0;
            const [x0, y0] = point(a, R0 - 10);
            const [x1, y1] = point(a, R0 - (major ? 16 : 13));
            return <line key={h} x1={x0} y1={y0} x2={x1} y2={y1} style={major ? tickMajor : tickMinor} />;
          })}
          {[0, 6, 12, 18].map((h) => {
            const [x, y] = point((h / 24) * 2 * Math.PI, R0 - 26);
            return (
              <text key={h} x={x} y={y + 3.5} textAnchor="middle" style={dialText}>
                {h}
              </text>
            );
          })}
        </svg>
        {hover && (
          <div style={{ ...tooltip, left: hover.x, top: hover.y }}>
            <div style={tipValue}>{formatDuration(hours.seconds[hover.hour])}</div>
            <div style={tipNote}>
              {hh(hover.hour)}–{hh(hover.hour + 1)} · {hours.activities[hover.hour]}{" "}
              {hours.activities[hover.hour] === 1 ? "activity" : "activities"}
            </div>
          </div>
        )}
      </div>
      <figcaption style={caption}>
        <span style={captionTitle}>{label}</span>
        <span style={tipNote}>
          {busiest == null
            ? "No time out"
            : `busiest ${hh(busiest)}–${hh(busiest + 1)} · ${formatDuration(hours.total)} in all`}
        </span>
      </figcaption>
    </figure>
  );
}

const layout: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: "20px 48px",
};

const figure: CSSProperties = { margin: 0, flex: "0 1 250px", minWidth: 200 };

const caption: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  marginTop: 10,
};

const captionTitle: CSSProperties = {
  fontSize: FS.sm,
  fontWeight: 600,
  color: "var(--text)",
};

const trackStyle: CSSProperties = { fill: "var(--heat-0)" };
const bar: CSSProperties = { fill: "var(--accent)", pointerEvents: "none" };
const outline: CSSProperties = {
  fill: "none",
  stroke: "var(--text-strong)",
  strokeWidth: 1.5,
  pointerEvents: "none",
};
const dial: CSSProperties = { fill: "var(--bg)", stroke: "var(--divider)", pointerEvents: "none" };
const tickMajor: CSSProperties = { stroke: "var(--text-soft)", strokeWidth: 1.5 };
const tickMinor: CSSProperties = { stroke: "var(--text-faint)", strokeWidth: 1 };
const dialText: CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  fontWeight: 600,
  fill: "var(--text)",
  pointerEvents: "none",
};

const tooltip: CSSProperties = {
  position: "absolute",
  zIndex: 2,
  transform: "translate(-50%, calc(-100% - 6px))",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  padding: "6px 9px",
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--panel-border)",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.28)",
};

const tipValue: CSSProperties = {
  fontFamily: MONO,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-strong)",
  marginBottom: 2,
};

const tipNote: CSSProperties = { fontSize: FS.xs + 0.5, color: "var(--text-muted)" };

const footnote: CSSProperties = {
  margin: "14px 0 0",
  textAlign: "center",
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
};
