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

export function rowStyle(on: boolean): CSSProperties {
  return {
    ...btnReset,
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    height: 34,
    padding: "0 10px",
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
