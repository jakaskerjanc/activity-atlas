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
import { MONO } from "./theme";

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
                {origin.name} <span style={arrow}>→</span> {c.pick.city.name}
              </div>
              <div style={detail}>{comparisonDetail(c)}</div>
            </div>
            <button
              type="button"
              style={showButton}
              onClick={() => onShowOnMap(c.profile)}
              aria-label={`Show ${title} ${PROFILE_TEXT[c.profile].by} on the map`}
            >
              Show on map →
            </button>
          </div>
        );
      })}
    </div>
  );
}

const statusText: CSSProperties = {
  margin: 0,
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-muted)",
};

// The stat cards' look: rows on the card background, split by hairlines.
const rows: CSSProperties = {
  display: "grid",
  gap: 1,
  background: "var(--card-grid)",
  borderRadius: 10,
  overflow: "hidden",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "10px 16px",
  background: "var(--card-bg)",
  padding: "12px 14px",
};

const groupLine: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const headline: CSSProperties = {
  marginTop: 4,
  fontSize: 19,
  fontWeight: 650,
  color: "var(--text-strong)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const leadText: CSSProperties = { fontWeight: 500, color: "var(--text-soft)" };

const arrow: CSSProperties = { color: "var(--accent-text)" };

const detail: CSSProperties = {
  marginTop: 4,
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-soft)",
};

const showButton: CSSProperties = {
  appearance: "none",
  cursor: "pointer",
  flex: "0 0 auto",
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid var(--accent)",
  background: "var(--accent-tint)",
  color: "var(--pill-on-text)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: ".02em",
  whiteSpace: "nowrap",
};
