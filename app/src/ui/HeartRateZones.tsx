// Heart-rate zones: how the visible activities' time with heart rate splits across the
// bands (below zone 1, zones 1 to 5). A strip of the whole split, a row per band that
// is both the legend and the table (name, bpm range, hours, share), then one stacked
// bar per month of the date range in hours, below zone 1 at the bottom. Colors are one
// violet ramp, ordered with the zones (--zone-0 … --zone-5 in index.css).

import { useState, type CSSProperties, type PointerEvent } from "react";
import { FS, MONO } from "./theme";
import { useElementWidth } from "./useElementWidth";
import { formatMonth } from "../format";
import { niceTicks } from "../profile";
import { formatHours, formatShare, ZONE_BANDS, type ZoneBand, type ZoneSummary } from "../hrZones";

const zoneColor = (i: number) => `var(--zone-${i})`;
const BANDS = Array.from({ length: ZONE_BANDS }, (_, i) => i);

export function HeartRateZones({
  summary,
  bands,
  compact = false,
}: {
  summary: ZoneSummary;
  bands: ZoneBand[];
  compact?: boolean;
}) {
  const { seconds, total, counted, missing } = summary;
  return (
    <>
      <div
        role="img"
        aria-label={`Time in heart-rate zones: ${bands
          .map((b, i) => `${b.label} ${formatShare(seconds[i], total)}`)
          .join(", ")}`}
        style={strip}
      >
        {BANDS.map((i) =>
          seconds[i] > 0 ? (
            <div key={i} style={{ flex: `${seconds[i]} 1 0`, minWidth: 2, background: zoneColor(i) }} />
          ) : null,
        )}
      </div>
      <ul style={rows}>
        {bands.map((b, i) => (
          <li key={i} style={row}>
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
      {summary.months.length > 1 && (
        <>
          <h3 style={subheading}>By month</h3>
          <MonthBars summary={summary} bands={bands} compact={compact} />
        </>
      )}
      {missing > 0 && (
        <p style={footnote}>
          {counted} of {counted + missing} activities have heart-rate zones; the other {missing}{" "}
          {missing === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
    </>
  );
}

const Y_AXIS_W = 40;
const X_AXIS_H = 20;
/** Gap between stacked segments, and between bars at most. */
const GAP = 2;

function MonthBars({ summary, bands, compact }: { summary: ZoneSummary; bands: ZoneBand[]; compact: boolean }) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(720);
  const [hover, setHover] = useState<number | null>(null);
  const { months } = summary;
  const plotW = Math.max(60, width - Y_AXIS_W);
  const plotH = compact ? 150 : 190;
  const maxH = Math.max(...months.map((m) => m.total)) / 3600;
  const ticks = maxH > 0 ? niceTicks(0, maxH, 3) : [0];
  const top = Math.max(maxH, ticks[ticks.length - 1]) || 1;
  const slot = plotW / months.length;
  const barW = Math.max(1, slot - Math.min(slot * 0.3, 6));
  const yOf = (h: number) => plotH - (h / top) * plotH;
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
        aria-label={`Hours in each heart-rate zone per month, ${formatMonth(months[0].month)} to ${formatMonth(months[months.length - 1].month)}`}
        onPointerMove={track}
        onPointerDown={track}
        style={{ display: "block", overflow: "visible" }}
      >
        <g transform={`translate(${Y_AXIS_W},0)`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={yOf(t)} y2={yOf(t)} style={gridLine} />
              <text x={-8} y={yOf(t) + 3.5} textAnchor="end" style={axisText}>
                {t} h
              </text>
            </g>
          ))}
          {months.map((m, i) => {
            const x = slot * i + (slot - barW) / 2;
            let y = plotH;
            const segs = BANDS.flatMap((b) => {
              const h = (m.seconds[b] / 3600 / top) * plotH;
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
              y={yOf(months[hover].total / 3600) - 2}
              width={barW + 4}
              height={plotH - yOf(months[hover].total / 3600) + 2}
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
            top: yOf(hovered.total / 3600),
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

const strip: CSSProperties = {
  display: "flex",
  gap: GAP,
  height: 16,
  borderRadius: 4,
  overflow: "hidden",
};

const rows: CSSProperties = {
  listStyle: "none",
  margin: "14px 0 0",
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))",
  gap: "12px 16px",
};

const row: CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start" };

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
  margin: "22px 0 10px",
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

const footnote: CSSProperties = {
  margin: "14px 0 0",
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
};
