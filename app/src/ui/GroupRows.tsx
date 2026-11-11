// The selected activity's place and same-route rows, under the stat cards. The place
// row takes you into the filter ("To Slavnik · 29 times →"); the route row opens, in
// place, a table of the other times on the route ("… · 10× ▸"). What they hold is
// routeGroup.ts's call; App decides what a pick does to the filter.

import { useId, type CSSProperties } from "react";
import { FS, MONO, R } from "./theme";
import { PeakIcon, SaddleIcon } from "./icons";
import { formatDate, formatDuration, formatPace } from "../format";
import type { PlaceLine, RouteRow, RouteTable } from "../routeGroup";

interface Props {
  place: PlaceLine | null;
  route: RouteTable | null;
  /** The route table is open. */
  open: boolean;
  onToggle: () => void;
  /** The place row: pick this place in the filter. */
  onPickPlace: (id: string) => void;
  /** A table row: select that activity. */
  onSelect: (id: string) => void;
}

export function GroupRows({ place, route, open, onToggle, onPickPlace, onSelect }: Props) {
  const listId = useId();
  if (!place && !route) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
      {place && (
        <button type="button" className="ctl" onClick={() => onPickPlace(place.id)} style={rowStyle}>
          <span style={markStyle}>{place.kind === "pass" ? <SaddleIcon size={13} /> : <PeakIcon size={11} />}</span>
          <span style={labelStyle}>
            {`${place.kind === "pass" ? "Over" : "To"} ${place.name} · ${place.count} ${place.count === 1 ? "time" : "times"}`}
          </span>
          <span aria-hidden="true" style={trailStyle}>
            →
          </span>
        </button>
      )}
      {route && (
        <>
          <button
            type="button"
            className="ctl"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={onToggle}
            style={rowStyle}
          >
            <span aria-hidden="true" style={markStyle}>
              ↻
            </span>
            <span style={labelStyle}>{`${route.name} · ${route.rows.length}×`}</span>
            <span aria-hidden="true" style={trailStyle}>
              {open ? "▾" : "▸"}
            </span>
          </button>
          {open && <RouteList id={listId} table={route} onSelect={onSelect} />}
        </>
      )}
    </div>
  );
}

/** The open table: one button per activity, newest first. */
function RouteList({ id, table, onSelect }: { id: string; table: RouteTable; onSelect: (id: string) => void }) {
  // Runs add a pace column; a run without one shows a dash so the columns line up.
  const paced = table.rows.some((r) => r.pace_s_per_km !== undefined);
  return (
    <ul id={id} aria-label={`Times on ${table.name}`} style={listStyle}>
      {table.rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className={row.current ? undefined : "ctl"}
            aria-current={row.current || undefined}
            onClick={() => onSelect(row.id)}
            style={tableRowStyle(row, paced)}
          >
            <span>{formatDate(row.ts)}</span>
            <span>{formatDuration(row.moving_time)}</span>
            {paced && <span>{row.pace_s_per_km === undefined ? "—" : `${formatPace(row.pace_s_per_km)} /km`}</span>}
            <span style={noteStyle(row)}>
              {[row.current && "← this one", row.fastest && "fastest"].filter(Boolean).join(" · ")}
            </span>
            {row.outside && <span className="sr-only">, outside the filter</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

const rowStyle: CSSProperties = {
  appearance: "none",
  border: "none",
  font: "inherit",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  minHeight: 34,
  padding: "7px 10px",
  borderRadius: R.sm,
  backgroundColor: "transparent",
  color: "var(--text)",
  fontSize: FS.md - 0.5,
  fontWeight: 500,
  lineHeight: 1.3,
};

const markStyle: CSSProperties = {
  width: 14,
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-muted)",
};

const labelStyle: CSSProperties = { flex: 1, minWidth: 0, textAlign: "left", overflowWrap: "anywhere" };

const trailStyle: CSSProperties = { flex: "0 0 auto", color: "var(--text-muted)" };

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: "0 0 4px",
  padding: "0 0 0 24px",
  display: "flex",
  flexDirection: "column",
  gap: 1,
};

// Date, time, (pace,) then the marks; mono so the columns line up. The current row is
// tinted like a picked place; rows outside the filter are greyed out.
function tableRowStyle(row: RouteRow, paced: boolean): CSSProperties {
  return {
    ...rowStyle,
    display: "grid",
    gridTemplateColumns: paced ? "12ch 7ch 9ch 1fr" : "12ch 7ch 1fr",
    gap: 10,
    minHeight: 28,
    padding: "4px 10px",
    textAlign: "left",
    fontFamily: MONO,
    fontSize: FS.xs + 0.5,
    whiteSpace: "nowrap",
    color: row.outside ? "var(--text-faint)" : "var(--text-soft)",
    ...(row.current && { backgroundColor: "var(--accent-tint)", color: "var(--pill-on-text)", fontWeight: 600 }),
  };
}

function noteStyle(row: RouteRow): CSSProperties {
  return {
    fontFamily: "var(--font-ui)",
    fontSize: FS.xs,
    color: row.current ? "var(--accent-text)" : row.outside ? "var(--text-faint)" : "var(--text-muted)",
    whiteSpace: "nowrap",
    textAlign: "right",
  };
}
