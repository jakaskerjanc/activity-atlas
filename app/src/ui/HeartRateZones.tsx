// Heart-rate zones: how the visible activities' time with heart rate splits across the
// bands (below zone 1, zones 1 to 5). A donut of the whole split beside a row per band
// that is both the legend and the table (name, bpm range, hours, share), then one stacked
// bar per month from the first month with zone time, in hours or as each month's own
// 100%, below zone 1 at the bottom. Colors are one violet ramp, ordered with the zones
// (--zone-0 … --zone-5 in index.css).

import { useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO, pillStyle } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { formatMonth } from "../format";
import { niceTicks } from "../profile";
import { formatHours, formatShare, ZONE_BANDS, type ZoneBand, type ZoneSummary } from "../hrZones";

const zoneColor = (i: number) => `var(--zone-${i})`;
const BANDS = Array.from({ length: ZONE_BANDS }, (_, i) => i);

/** The monthly bars' scale: hours out, or each month as its own 100%. */
export type BarScale = "hours" | "share";

export function HeartRateZones({
  summary,
  bands,
  compact = false,
}: {
  summary: ZoneSummary;
  bands: ZoneBand[];
  compact?: boolean;
}) {
  const { seconds, total } = summary;
  const [hovered, setHovered] = useState<number | null>(null);
  const [scale, setScale] = useState<BarScale>("hours");
  return (
    <>
      <div style={overview}>
        <ZoneDonut seconds={seconds} total={total} bands={bands} hovered={hovered} onHover={setHovered} />
        <ul style={{ ...rows, gridTemplateColumns: `repeat(${compact ? 2 : 3}, minmax(0, 1fr))` }}>
          {bands.map((b, i) => (
            <li
              key={i}
              style={{ ...row, background: hovered === i ? "var(--control-hover)" : undefined }}
              onPointerEnter={() => setHovered(i)}
              onPointerLeave={() => setHovered(null)}
            >
              <span style={{ ...swatch, background: zoneColor(i) }} aria-hidden />
              <span style={rowText}>
                <span style={rowLabel}>{b.label}</span>
                <span style={rowRange}>{b.range}</span>
                <span style={rowValue}>
                  {formatHours(seconds[i])} · {formatShare(seconds[i], total)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      {summary.months.length > 1 && (
        <>
          <div style={barsHeader}>
            <h3 style={subheading}>By month</h3>
            <div role="group" aria-label="Bar scale" style={{ display: "flex", gap: 6 }}>
              {(
                [
                  ["hours", "Hours"],
                  ["share", "Share"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={scale === value ? undefined : "ctl"}
                  aria-pressed={scale === value}
                  onClick={() => setScale(value)}
                  style={pillStyle(scale === value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <MonthBars summary={summary} bands={bands} scale={scale} compact={compact} />
        </>
      )}
    </>
  );
}

const DONUT = 168;
/** Ring centre-line radius and thickness. */
const RING_R = 68;
const RING_W = 24;

/**
 * The whole split as a ring, zone 1 onwards clockwise from the top. Hovering a segment
 * (or its row) puts that band's time and share in the middle; otherwise it holds the total.
 */
function ZoneDonut({
  seconds,
  total,
  bands,
  hovered,
  onHover,
}: {
  seconds: number[];
  total: number;
  bands: ZoneBand[];
  hovered: number | null;
  onHover: (band: number | null) => void;
}) {
  const circ = 2 * Math.PI * RING_R;
  const shown = BANDS.filter((b) => seconds[b] > 0);
  // A surface gap between segments, except when one band is the whole ring.
  const gap = shown.length > 1 ? GAP : 0;
  let start = 0;
  const segs = shown.map((b) => {
    const len = (seconds[b] / total) * circ;
    const seg = { band: b, start, len };
    start += len;
    return seg;
  });
  const focus = hovered != null && seconds[hovered] > 0 ? hovered : null;
  return (
    <svg
      width={DONUT}
      height={DONUT}
      viewBox={`0 0 ${DONUT} ${DONUT}`}
      role="img"
      aria-label={`Time in heart-rate zones: ${bands.map((b, i) => `${b.label} ${formatShare(seconds[i], total)}`).join(", ")}`}
      style={{ display: "block", flex: "none" }}
      onPointerLeave={() => onHover(null)}
    >
      <g transform={`rotate(-90 ${DONUT / 2} ${DONUT / 2})`}>
        {segs.map(({ band, start, len }) => {
          const drawn = Math.max(0.5, len - gap);
          return (
            <circle
              key={band}
              cx={DONUT / 2}
              cy={DONUT / 2}
              r={RING_R}
              fill="none"
              stroke={zoneColor(band)}
              strokeWidth={focus === band ? RING_W + 6 : RING_W}
              strokeDasharray={`${drawn} ${circ - drawn}`}
              strokeDashoffset={-start}
              opacity={focus == null || focus === band ? 1 : 0.45}
              onPointerEnter={() => onHover(band)}
              style={{ transition: "opacity 120ms, stroke-width 120ms" }}
            />
          );
        })}
      </g>
      <text x={DONUT / 2} y={DONUT / 2 - 2} textAnchor="middle" style={donutValue}>
        {focus == null ? formatHours(total) : formatShare(seconds[focus], total)}
      </text>
      <text x={DONUT / 2} y={DONUT / 2 + 15} textAnchor="middle" style={donutNote}>
        {focus == null ? "with heart rate" : bands[focus].label}
      </text>
    </svg>
  );
}

const Y_AXIS_W = 40;
const X_AXIS_H = 20;
/** Gap between stacked segments, and between bars at most. */
const GAP = 2;

function MonthBars({
  summary,
  bands,
  scale,
  compact,
}: {
  summary: ZoneSummary;
  bands: ZoneBand[];
  scale: BarScale;
  compact: boolean;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<number | null>(null);
  const { months } = summary;
  const plotW = Math.max(60, width - Y_AXIS_W);
  const plotH = compact ? 150 : 190;
  const share = scale === "share";
  // Each month's height in the chart's unit: hours, or 100 (%) for any month with time.
  const value = (m: { total: number }) => (share ? (m.total > 0 ? 100 : 0) : m.total / 3600);
  const maxH = Math.max(...months.map((m) => m.total)) / 3600;
  const ticks = share ? [0, 50, 100] : maxH > 0 ? niceTicks(0, maxH, 3) : [0];
  const top = share ? 100 : Math.max(maxH, ticks[ticks.length - 1]) || 1;
  const unit = share ? "%" : " h";
  const slot = plotW / months.length;
  const barW = Math.max(1, slot - Math.min(slot * 0.3, 6));
  const yOf = (v: number) => plotH - (v / top) * plotH;
  // A label under January (the year) and under the first month; every month's short name
  // as well when the range is a year or less.
  const short = months.length <= 12;
  /** Slots a year label needs (about 34 px). */
  const firstClear = Math.ceil(34 / slot);

  const track = (e: PointerEvent<SVGSVGElement>) => {
    const i = (e.target as Element).getAttribute("data-i");
    setHover(i == null ? null : Number(i));
  };

  const hovered = hover != null ? months[hover] : null;
  const tipLeft = hover != null ? Y_AXIS_W + slot * (hover + 0.5) : 0;

  return (
    <div ref={boxRef} style={{ position: "relative" }} onPointerLeave={() => setHover(null)}>
      <svg
        width={width}
        height={plotH + X_AXIS_H}
        role="img"
        aria-label={`${share ? "Share of time" : "Hours"} in each heart-rate zone per month, ${formatMonth(months[0].month)} to ${formatMonth(months[months.length - 1].month)}`}
        onPointerMove={track}
        onPointerDown={track}
        style={{ display: "block", overflow: "visible" }}
      >
        <g transform={`translate(${Y_AXIS_W},0)`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={yOf(t)} y2={yOf(t)} style={gridLine} />
              <text x={-8} y={yOf(t) + 3.5} textAnchor="end" style={axisText}>
                {t}
                {unit}
              </text>
            </g>
          ))}
          {months.map((m, i) => {
            const x = slot * i + (slot - barW) / 2;
            let y = plotH;
            const segs = BANDS.flatMap((b) => {
              const v = share ? (100 * m.seconds[b]) / m.total : m.seconds[b] / 3600;
              const h = (v / top) * plotH;
              if (h <= 0) return [];
              y -= h;
              // The gap comes off the segment's top, so the stack keeps its true height.
              const drawn = h > GAP + 0.5 ? h - GAP : h;
              return [<rect key={b} x={x} y={y + (h - drawn)} width={barW} height={drawn} rx={1.5} fill={zoneColor(b)} />];
            });
            // The first month's year only when the next January is far enough not to collide.
            const yearLabel = m.month % 12 === 0 || (i === 0 && !months.slice(1, firstClear).some((n) => n.month % 12 === 0));
            const label = short
              ? new Date(Date.UTC(Math.floor(m.month / 12), m.month % 12, 1)).toLocaleDateString("en-US", {
                  month: "short",
                  timeZone: "UTC",
                })
              : yearLabel
                ? String(Math.floor(m.month / 12))
                : null;
            return (
              <g key={m.month}>
                {segs}
                {label && (
                  <text x={slot * i + (short ? slot / 2 : 0)} y={plotH + 14} textAnchor={short ? "middle" : "start"} style={axisText}>
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          {hover != null && (
            <rect
              x={slot * hover + (slot - barW) / 2 - 2}
              y={yOf(value(months[hover])) - 2}
              width={barW + 4}
              height={plotH - yOf(value(months[hover])) + 2}
              rx={3}
              style={outline}
            />
          )}
          {months.map((m, i) => (
            <rect key={`hit${m.month}`} data-i={i} x={slot * i} y={0} width={slot} height={plotH} fill="transparent" />
          ))}
        </g>
      </svg>
      {hovered && (
        <div
          style={{
            ...tooltip,
            left: Math.min(Math.max(tipLeft, 90), width - 90),
            top: yOf(value(hovered)),
          }}
        >
          <div style={tipValue}>{formatMonth(hovered.month)}</div>
          {hovered.total > 0 ? (
            <>
              <div style={tipNote}>
                {formatHours(hovered.total)} · {hovered.activities}{" "}
                {hovered.activities === 1 ? "activity" : "activities"}
              </div>
              <table style={tipTable}>
                <tbody>
                  {[...BANDS].reverse().map((b) => (
                    <tr key={b}>
                      <td>
                        <span style={{ ...swatch, width: 8, height: 8, background: zoneColor(b) }} aria-hidden />
                      </td>
                      <td style={tipCell}>{bands[b].label}</td>
                      <td style={{ ...tipCell, ...tipNum }}>{formatHours(hovered.seconds[b])}</td>
                      <td style={{ ...tipCell, ...tipNum }}>{formatShare(hovered.seconds[b], hovered.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div style={tipNote}>No time with heart rate</div>
          )}
        </div>
      )}
    </div>
  );
}

const overview: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "center",
  gap: "16px 28px",
};

const donutValue: CSSProperties = {
  fontFamily: MONO,
  fontSize: 18,
  fontWeight: 600,
  fill: "var(--text-strong)",
};
const donutNote: CSSProperties = { fontSize: FS.xs, fill: "var(--text-muted)" };

const barsHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  margin: "22px 0 10px",
};

const rows: CSSProperties = {
  flex: "1 1 300px",
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "4px 8px",
};

const row: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  padding: "5px 8px",
  borderRadius: 8,
  transition: "background 120ms",
};

const swatch: CSSProperties = {
  display: "inline-block",
  flex: "none",
  width: 10,
  height: 10,
  marginTop: 3,
  borderRadius: 3,
};

const rowText: CSSProperties = { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 };
const rowLabel: CSSProperties = { fontSize: FS.sm, fontWeight: 600, color: "var(--text)" };
const rowRange: CSSProperties = { fontSize: FS.xs, color: "var(--text-muted)" };
const rowValue: CSSProperties = { fontFamily: MONO, fontSize: FS.sm, color: "var(--text-strong)" };

const subheading: CSSProperties = {
  margin: 0,
  fontSize: FS.xs,
  fontWeight: 600,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const gridLine: CSSProperties = { stroke: "var(--card-grid)", strokeWidth: 1 };
const axisText: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS["2xs"],
  fill: "var(--text-muted)",
  pointerEvents: "none",
};
const outline: CSSProperties = {
  fill: "none",
  stroke: "var(--text-strong)",
  strokeWidth: 1.5,
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
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-strong)",
  marginBottom: 2,
};
const tipNote: CSSProperties = { fontSize: FS.xs + 0.5, color: "var(--text-muted)" };
const tipTable: CSSProperties = { borderCollapse: "collapse", marginTop: 4 };
const tipCell: CSSProperties = { fontSize: FS.xs + 0.5, color: "var(--text)", padding: "1px 0 1px 6px" };
const tipNum: CSSProperties = { fontFamily: MONO, textAlign: "right", paddingLeft: 10 };
