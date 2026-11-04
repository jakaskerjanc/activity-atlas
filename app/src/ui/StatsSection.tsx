// Stats: aggregate totals, or a single activity's stats when one is selected.
// Rendered as a section inside the merged SidePanel.

import type { CSSProperties } from "react";
import { MONO } from "./theme";
import type { StatCard } from "../stats";

interface HeadingProps {
  title: string;
  subtitle: string;
  /** Source links. The title links to the first; the rest are listed under the subtitle. */
  links?: { url: string; label: string }[];
}

interface Props extends HeadingProps {
  cards: StatCard[];
  /** One row of four smaller cards (when charts sit below). */
  compact?: boolean;
  /** Cards per row. Defaults to 4 when compact, else a 2x2 grid. */
  columns?: number;
}

export function StatsSection({ title, subtitle, cards, links, compact = false, columns }: Props) {
  return (
    <>
      <SectionHeading title={title} subtitle={subtitle} links={links} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns ?? (compact ? 4 : 2)}, 1fr)`,
          gap: 1,
          background: "var(--card-grid)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {cards.map((c) => (
          <div
            key={c.label}
            style={{ background: "var(--card-bg)", padding: compact ? "8px 10px" : "10px 12px" }}
          >
            <div style={{ ...(c.accent ? accentVal : bigVal), ...(compact ? { fontSize: 16 } : {}) }}>
              {c.value}
            </div>
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

/** A panel section's title (a link to the first source, if any) over a small uppercase
 * subtitle, then any further source links. */
export function SectionHeading({ title, subtitle, links = [] }: HeadingProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      {links.length > 0 ? (
        // The title links to the first source, as the single link always did.
        <a
          href={links[0].url}
          target="_blank"
          rel="noopener noreferrer"
          title={links[0].label}
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
      {links.slice(1).map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" style={extraLink}>
          {l.label}
        </a>
      ))}
    </div>
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

// Sources beyond the first (a merged Strava + Garmin activity).
const extraLink: CSSProperties = {
  display: "block",
  fontSize: 10,
  letterSpacing: ".14em",
  color: "var(--accent-text)",
  textTransform: "uppercase",
  fontFamily: MONO,
  textDecoration: "none",
  marginTop: 4,
};
