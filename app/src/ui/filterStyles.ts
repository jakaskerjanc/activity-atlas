// The filter panel's list rows, shared by the type list and the places list so the two
// read as one control: a full-width button, a label, and a mono count at the right.

import type { CSSProperties } from "react";
import { FS, MONO, R } from "./theme";

const btnReset: CSSProperties = {
  appearance: "none",
  border: "none",
  font: "inherit",
  cursor: "pointer",
};

export const divider: CSSProperties = {
  border: 0,
  height: 1,
  background: "var(--divider)",
  margin: "16px 0",
};

// The row's padding hangs outside the column (ROW_BLEED), so the swatch and the count
// line up with the section labels and the slider; only the hover fill reaches past them.
export const ROW_BLEED = 10;

export function rowStyle(on: boolean): CSSProperties {
  return {
    ...btnReset,
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: `calc(100% + ${2 * ROW_BLEED}px)`,
    margin: `0 -${ROW_BLEED}px`,
    height: 34,
    padding: `0 ${ROW_BLEED}px`,
    borderRadius: R.sm,
    backgroundColor: "transparent",
    color: on ? "var(--text)" : "var(--text-dim)",
    fontSize: FS.md - 0.5,
    fontWeight: 500,
  };
}

export function countStyle(on: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: FS.xs + 0.5,
    color: on ? "var(--text-muted)" : "var(--text-faint)",
  };
}
