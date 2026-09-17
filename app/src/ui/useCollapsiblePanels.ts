// Collapse state for the two overlay panels. Both share one rule: a resize that crosses
// the narrow breakpoint wins, collapsing on the way down and expanding on the way up.
// Between crossings the user's edge-tab toggles are respected.

import { useEffect, useState } from "react";
import { BOTH_PANELS_QUERY, COLLAPSE_QUERY } from "./layout";
import { useMediaQuery } from "./useMediaQuery";

export interface CollapsiblePanels {
  sideCollapsed: boolean;
  bottomCollapsed: boolean;
  toggleSide: () => void;
  toggleBottom: () => void;
}

/**
 * Which panels the width rules force collapsed. Narrow: both give the map room. Too
 * narrow for both: the centered bottom panel keeps its slot and the side panel gives way.
 */
export function forcedCollapse(
  narrow: boolean,
  bothFit: boolean,
): { side: boolean; bottom: boolean } {
  return { side: narrow || !bothFit, bottom: narrow };
}

export function useCollapsiblePanels(): CollapsiblePanels {
  // A resize across either boundary re-applies `forced`, overriding a manual toggle
  // until the next crossing.
  const narrow = useMediaQuery(COLLAPSE_QUERY);
  const bothFit = useMediaQuery(BOTH_PANELS_QUERY);
  const forced = forcedCollapse(narrow, bothFit);

  const [sideCollapsed, setSideCollapsed] = useState(forced.side);
  const [bottomCollapsed, setBottomCollapsed] = useState(forced.bottom);

  useEffect(() => {
    setSideCollapsed(forced.side);
    setBottomCollapsed(forced.bottom);
  }, [forced.side, forced.bottom]);

  return {
    sideCollapsed,
    bottomCollapsed,
    toggleSide: () => setSideCollapsed((v) => !v),
    toggleBottom: () => setBottomCollapsed((v) => !v),
  };
}
