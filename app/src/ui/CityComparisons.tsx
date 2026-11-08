// The analytics page's distance comparisons: per group (rides, on foot), the city the
// visible activities' distance would reach from the origin, with a button that shows
// that route on the map.

import type { CSSProperties } from "react";
import type { CityComparison } from "../cityMatch";
import {
  comparisonDetail,
  formatTripKm,
  pickLead,
  PROFILE_TEXT,
  routeTitle,
} from "../cityView";
import type { Profile } from "../types";
import type { CitiesState } from "./useCities";
import { FS, R } from "./theme";
import { ArrowRightIcon, MapIcon } from "./icons";

interface Props {
  cities: CitiesState;
  /** One per group with distance, from cityComparisons over the visible activities. */
  comparisons: CityComparison[];
  /** Switch to the map, showing this group's route. */
  onShowOnMap: (profile: Profile) => void;
}

export function CityComparisons({ cities, comparisons, onShowOnMap }: Props) {
  if (cities.status !== "ready") {
    return (
      <p style={statusText}>
        {cities.status === "loading" ? "Loading cities…" : "Couldn't load the city distances."}
      </p>
    );
  }
  if (comparisons.length === 0) {
    return <p style={statusText}>No visible ride, run, walk or hike has a distance.</p>;
  }
  const { origin } = cities.data;
  return (
    <div style={rows}>
      {comparisons.map((c) => {
        const title = routeTitle(origin, c.pick.city);
        const lead = pickLead(c);
        return (
          <div key={c.profile} style={row}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div style={groupLine}>
                {`${PROFILE_TEXT[c.profile].group} · ${formatTripKm(c.totalM)} km`}
              </div>
              <div style={headline} title={title}>
                {lead && <span style={leadText}>{lead} </span>}
                {origin.name}{" "}
                <span style={arrow}>
                  <ArrowRightIcon size={17} />
                  <span className="sr-only">to</span>
                </span>{" "}
                {c.pick.city.name}
              </div>
              <div style={detail}>{comparisonDetail(c)}</div>
            </div>
            <button
              type="button"
              className="ctl-accent"
              style={showButton}
              onClick={() => onShowOnMap(c.profile)}
              // Starts with the visible text, so speech users can say what they see.
              aria-label={`Show on map: ${origin.name} to ${c.pick.city.name} ${PROFILE_TEXT[c.profile].by}`}
            >
              <MapIcon size={14} />
              Show on map
            </button>
          </div>
        );
      })}
    </div>
  );
}

const statusText: CSSProperties = {
  margin: 0,
  fontSize: FS.sm,
  color: "var(--text-muted)",
};

// The stat cards' look: rows on the card background, split by hairlines.
const rows: CSSProperties = {
  display: "grid",
  gap: 1,
  background: "var(--card-grid)",
  border: "1px solid var(--card-grid)",
  borderRadius: R.md,
  overflow: "hidden",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "10px 16px",
  background: "var(--bg-raised)",
  padding: "14px 16px",
};

const groupLine: CSSProperties = {
  fontSize: FS.sm,
  fontWeight: 500,
  color: "var(--text-muted)",
};

const headline: CSSProperties = {
  marginTop: 4,
  fontSize: 20,
  fontWeight: 650,
  letterSpacing: "-.01em",
  color: "var(--text-strong)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const leadText: CSSProperties = { fontWeight: 500, color: "var(--text-soft)" };

const arrow: CSSProperties = { color: "var(--accent-text)", display: "inline-flex", verticalAlign: "-2px" };

const detail: CSSProperties = {
  marginTop: 4,
  fontSize: FS.sm,
  fontVariantNumeric: "tabular-nums",
  color: "var(--text-soft)",
};

const showButton: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  height: 34,
  padding: "0 14px",
  borderRadius: R.sm,
  border: "1px solid var(--accent)",
  background: "var(--accent-tint)",
  color: "var(--pill-on-text)",
  fontFamily: "inherit",
  fontSize: FS.sm,
  fontWeight: 600,
  whiteSpace: "nowrap",
};
