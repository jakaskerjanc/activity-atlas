// Filter state + Mapbox filter-expression builder.
// This is the contract the UI (Claude Design later) drives.

import type { FilterSpecification } from "mapbox-gl";

export interface FilterState {
  /** Selected activity types; empty means "show all types". */
  types: string[];
  /** Inclusive lower bound, epoch seconds (undefined = no lower bound). */
  from?: number;
  /** Inclusive upper bound, epoch seconds (undefined = no upper bound). */
  to?: number;
}

export const emptyFilter: FilterState = { types: [] };

/**
 * Build a Mapbox GL filter expression from FilterState, matched against the
 * `type` and `ts` feature properties. Returns null when nothing is constrained.
 */
export function buildFilter(state: FilterState): FilterSpecification | null {
  const clauses: unknown[] = ["all"];

  if (state.types.length > 0) {
    clauses.push(["in", ["get", "type"], ["literal", state.types]]);
  }
  if (state.from !== undefined) {
    clauses.push([">=", ["get", "ts"], state.from]);
  }
  if (state.to !== undefined) {
    clauses.push(["<=", ["get", "ts"], state.to]);
  }

  if (clauses.length === 1) return null; // only "all" — no constraints
  return clauses as unknown as FilterSpecification;
}
