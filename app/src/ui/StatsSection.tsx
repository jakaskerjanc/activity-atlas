// Stats: aggregate totals, or a single activity's stats when one is selected.
// Rendered as a section inside the merged SidePanel.

import type { CSSProperties } from "react";
import { MONO } from "./theme";
import type { StatCard } from "../stats";

interface Props {
  title: string;
  subtitle: string;
  cards: StatCard[];
  stravaUrl?: string | null;
}

export function StatsSection({ title, subtitle, cards, stravaUrl }: Props) {
  return (
    <>
      <div style={{ marginBottom: 12 }}>
        {stravaUrl ? (
          <a
            href={stravaUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="View on Strava"
            style={titleLink}
          >
            {title}
          </a>
        ) : (
          <span style={titleText}>{title}</span>
        )}
        <span
          style={{
            display: "block",
            fontSize: 10,
            letterSpacing: ".14em",
            color: "var(--text-muted)",
            textTransform: "uppercase",
            fontFamily: MONO,
            marginTop: 4,
          }}
        >
          {subtitle}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
          background: "var(--card-grid)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {cards.map((c) => (
          <div key={c.label} style={{ background: "var(--card-bg)", padding: "10px 12px" }}>
            <div style={c.accent ? accentVal : bigVal}>{c.value}</div>
            <div
              style={{
                fontSize: 10,
                letterSpacing: ".12em",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                marginTop: 3,
              }}
            >
              {c.label}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const bigVal: CSSProperties = {
  fontFamily: MONO,
  fontSize: 21,
  fontWeight: 600,
  color: "var(--text-strong)",
};
const accentVal: CSSProperties = { ...bigVal, color: "var(--accent-text)" };

const titleText: CSSProperties = {
  display: "block",
  fontSize: 15,
  fontWeight: 700,
  color: "var(--text)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const titleLink: CSSProperties = {
  ...titleText,
  textDecoration: "none",
  cursor: "pointer",
};
