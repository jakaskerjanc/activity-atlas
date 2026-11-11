// The filter panel's places list: the summits, passes and tops the activities reach,
// most visited first, each a toggle that narrows the filter to that place. Which rows
// show is listedPlaces' call (places.ts); this component keeps the search text and
// whether the full list is open, and draws the rows in the type list's style.

import { useId, useMemo, useState, type CSSProperties } from "react";
import { FS, MONO, R, sectionLabel } from "./theme";
import { countStyle, divider, rowStyle } from "./filterStyles";
import { PeakIcon, SaddleIcon } from "./icons";
import { placeCounts, togglePlace, type ActivityFilter } from "../activityFilter";
import { listedPlaces, PLACES_SHOWN, type PlaceRow } from "../places";
import { formatMeters } from "../format";
import type { Place } from "../types";

interface Props {
  filter: ActivityFilter;
  /** Every place in places.json; none hides the section. */
  places: readonly Place[];
  onChange: (filter: ActivityFilter) => void;
}

export function PlacesSection({ filter, places, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const searchId = useId();
  const listId = useId();
  // Memoized: App re-renders every replay frame, and the filter only changes on input.
  const counts = useMemo(() => placeCounts(filter), [filter]);
  const { rows, more } = useMemo(
    () => listedPlaces(places, counts, filter.place, query, expanded),
    [places, counts, filter.place, query, expanded],
  );
  if (places.length === 0) return null;
  const searching = query.trim() !== "";
  // Open, and longer than the short list: offer closing it again.
  const canClose = expanded && !searching && rows.length > PLACES_SHOWN;
  return (
    <>
      <hr style={divider} />
      <h3 style={{ ...sectionLabel, marginBottom: 8 }}>Places</h3>
      <label htmlFor={searchId} className="sr-only">
        Search places
      </label>
      <input
        id={searchId}
        type="search"
        placeholder="Search places"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={searchBox}
      />
      <div id={listId} role="group" aria-label="Places" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((row) => (
          <PlaceButton key={row.place.id} row={row} onClick={() => onChange(togglePlace(filter, row.place.id))} />
        ))}
      </div>
      {searching && rows.length === 0 && <p style={note}>No places match “{query.trim()}”.</p>}
      {more > 0 && (
        <button
          type="button"
          className="ctl"
          aria-expanded={false}
          aria-controls={listId}
          onClick={() => setExpanded(true)}
          style={moreButton}
        >
          {`+ ${more} more`}
        </button>
      )}
      {canClose && (
        <button
          type="button"
          className="ctl"
          aria-expanded={true}
          aria-controls={listId}
          onClick={() => setExpanded(false)}
          style={moreButton}
        >
          Show fewer
        </button>
      )}
    </>
  );
}

/** One place: kind mark, name (wrapping), height, then the count at the right. */
function PlaceButton({ row, onClick }: { row: PlaceRow; onClick: () => void }) {
  const { place, count, selected } = row;
  return (
    <button
      type="button"
      className={selected ? undefined : "ctl"}
      aria-pressed={selected}
      onClick={onClick}
      style={placeRowStyle(selected)}
    >
      <span style={kindMark(selected)}>
        {place.kind === "peak" ? <PeakIcon size={11} /> : place.kind === "pass" ? <SaddleIcon size={13} /> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0, textAlign: "left", overflowWrap: "anywhere" }}>{place.name}</span>
      <span style={heightStyle}>{`${formatMeters(place.ele)} m`}</span>
      <span style={{ ...countStyle(true), minWidth: "3ch", textAlign: "right" }}>{count}</span>
    </button>
  );
}

// Every place row reads like an on type; the picked one is tinted like a picked pill.
function placeRowStyle(selected: boolean): CSSProperties {
  return {
    ...rowStyle(true),
    height: "auto",
    minHeight: 34,
    padding: "7px 10px",
    lineHeight: 1.3,
    ...(selected && {
      backgroundColor: "var(--accent-tint)",
      color: "var(--pill-on-text)",
      fontWeight: 600,
    }),
  };
}

function kindMark(selected: boolean): CSSProperties {
  return {
    width: 14,
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: selected ? "var(--accent)" : "var(--text-muted)",
  };
}

// Mono and right-aligned in a fixed width, so the heights line up as a column.
const heightStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
  minWidth: "7ch",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const searchBox: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  height: 32,
  margin: "0 0 6px",
  padding: "0 10px",
  borderRadius: R.sm,
  border: "1px solid var(--control-border)",
  background: "var(--control-bg)",
  color: "var(--text)",
  font: "inherit",
  fontSize: FS.sm + 0.5,
};

const moreButton: CSSProperties = {
  ...rowStyle(false),
  height: 30,
  marginTop: 2,
  color: "var(--text-muted)",
  fontSize: FS.sm + 0.5,
};

const note: CSSProperties = {
  margin: "4px 10px",
  fontSize: FS.sm,
  color: "var(--text-muted)",
};
