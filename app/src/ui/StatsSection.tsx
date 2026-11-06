// Stat cards (a value, its unit, and a label) and the section heading used by panels and
// analytics cards. Values are mono numerals that never wrap; labels are sentence case.

import type { CSSProperties, ReactNode } from "react";
import { FS, MONO, R } from "./theme";
import type { StatCard } from "../stats";

interface Props {
  cards: StatCard[];
  /** Smaller values, for a row of four above charts. */
  compact?: boolean;
  /** Cards per row. Defaults to 4 when compact, else a 2x2 grid. */
  columns?: number;
}

export function StatGrid({ cards, compact = false, columns }: Props) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns ?? (compact ? 4 : 2)}, 1fr)`,
        gap: 1,
        background: "var(--card-grid)",
        border: "1px solid var(--card-grid)",
        borderRadius: R.md,
        overflow: "hidden",
      }}
    >
      {cards.map((c) => (
        <div
          key={c.label}
          style={{ background: "var(--stat-cell-bg)", padding: compact ? "10px 10px 9px" : "12px 14px 11px", minWidth: 0 }}
        >
          <div style={{ ...value, ...(c.accent ? accent : null), fontSize: compact ? 16 : FS.xl }}>
            {c.value}
            {c.unit && <span style={unit}>{c.unit}</span>}
          </div>
          <div style={label}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

/** A card or panel section's title over a short sentence-case subtitle. */
export function SectionHeading({
  title,
  subtitle,
  aside,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned extra (a count, a control). */
  aside?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={heading}>{title}</h2>
        {subtitle && <p style={sub}>{subtitle}</p>}
      </div>
      {aside}
    </div>
  );
}

const value: CSSProperties = {
  fontFamily: MONO,
  fontWeight: 600,
  color: "var(--text-strong)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  lineHeight: 1.15,
  letterSpacing: "-.01em",
};
const accent: CSSProperties = { color: "var(--accent-text)" };

const unit: CSSProperties = {
  marginLeft: 4,
  fontFamily: "var(--font-ui)",
  fontSize: FS.xs + 1,
  fontWeight: 500,
  color: "var(--text-muted)",
  letterSpacing: 0,
};

const label: CSSProperties = {
  marginTop: 4,
  fontSize: FS.xs + 0.5,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const heading: CSSProperties = {
  margin: 0,
  fontSize: FS.lg,
  fontWeight: 650,
  color: "var(--text-strong)",
  letterSpacing: "-.005em",
};

const sub: CSSProperties = {
  margin: "3px 0 0",
  fontSize: FS.sm,
  color: "var(--text-muted)",
  lineHeight: 1.4,
};
