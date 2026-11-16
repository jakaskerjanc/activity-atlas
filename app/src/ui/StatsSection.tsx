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
            <StatValue card={c} />
          </div>
          <div style={label}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Stats without the boxes: the cards' type (a mono value over a muted label) for a
 * surface that already groups them, such as an open activity in the Activities list.
 * Each cell is as wide as it needs, a hairline between neighbours; with `columns` they
 * wrap into that many equal columns instead of one row.
 */
export function StatList({ cards, columns, pad = 20 }: { cards: StatCard[]; columns?: number; pad?: number }) {
  const perRow = columns ?? cards.length;
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
                // In one row each cell is as wide as its stat, and gives way (its value ellipsed)
        // only when the row runs out of room.
        gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, 1fr))` : `repeat(${perRow}, minmax(0, max-content))`,
        rowGap: 12,
      }}
    >
      {cards.map((c, i) => {
        // A cell starts a row when the cells before it fill whole rows (a wide one, in
        // a grid, takes two columns).
        const span = columns && c.wide ? Math.min(2, columns) : 1;
        const before = cards.slice(0, i).reduce((n, d) => n + (columns && d.wide ? Math.min(2, columns) : 1), 0);
        const first = before % perRow === 0 || (before % perRow) + span > perRow;
        return (
          // The label comes first for a screen reader ("Pace, 5:06 /km") and shows second.
          <div
            key={c.label}
            style={{
              display: "flex",
              flexDirection: "column-reverse",
              minWidth: 0,
              gridColumn: span > 1 ? `span ${span}` : undefined,
              padding: first ? `0 ${pad}px 0 0` : `0 ${pad}px`,
              borderLeft: first ? undefined : "1px solid var(--card-grid)",
            }}
          >
            <dt style={label}>{c.label}</dt>
            <dd style={{ ...value, ...(c.accent ? accent : null), margin: 0, fontSize: 16 }}>
              <StatValue card={c} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A value in a title or header line: an optional muted label, the mono value, its
 * muted unit ("High point 1,029 m", "avg 115").
 */
export function Reading({ label: name, value: v, unit: u }: { label?: string; value: string; unit?: string }) {
  return (
    <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
      {name && <>{name} </>}
      <span style={{ fontFamily: MONO, fontWeight: 600, color: "var(--text-strong)" }}>{v}</span>
      {u && <> {u}</>}
    </span>
  );
}

/** A stat's value with its unit; a duration's numbers each with their own h / m. */
function StatValue({ card: c }: { card: StatCard }) {
  return c.parts ? (
    <>
      <span className="sr-only">{c.value}</span>
      <span aria-hidden="true">
        {c.parts.map((p, i) => (
          <span key={i} style={i > 0 ? { marginLeft: ".3em" } : undefined}>
            {p.value}
            <span style={partUnit}>{p.unit}</span>
          </span>
        ))}
      </span>
    </>
  ) : (
    <>
      {c.value}
      {c.unit && <span style={unit}>{c.unit}</span>}
    </>
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

// A duration's h / m: the unit style, without the gap a word unit takes.
const partUnit: CSSProperties = { ...unit, marginLeft: 1 };

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
