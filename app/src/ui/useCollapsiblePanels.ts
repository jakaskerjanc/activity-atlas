// Collapse state for the two overlay panels. Both share one rule: a resize that crosses
// a layout boundary wins (collapsing on the way down, expanding on the way up); between
// crossings the user's own toggles are respected.

import { useEffect, useState } from "react";
import { BOTH_PANELS_QUERY, MOBILE_QUERY } from "./layout";
import { useMediaQuery } from "./useMediaQuery";

export interface CollapsiblePanels {
  /** The phone layout: filters as an overlay, details as a bottom sheet. */
  mobile: boolean;
  /** Filters panel hidden (slid off on desktop, closed overlay on a phone). */
  sideCollapsed: boolean;
  /** Detail panel showing only its header strip (the phone sheet's peek). */
  bottomCollapsed: boolean;
  toggleSide: () => void;
  closeSide: () => void;
  toggleBottom: () => void;
  /** Force the detail panel open (e.g. when a city route is asked for). */
  expandBottom: () => void;
}

/**
 * Which panels the width rules force collapsed. Phone: both give the map room (the
 * filters overlay closed, the sheet at its peek). Too narrow for both docked panels: the
 * detail panel keeps its slot and the filters give way.
 */
export function forcedCollapse(
  mobile: boolean,
  bothFit: boolean,
): { side: boolean; bottom: boolean } {
  return { side: mobile || !bothFit, bottom: mobile };
}

export function useCollapsiblePanels(): CollapsiblePanels {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const bothFit = useMediaQuery(BOTH_PANELS_QUERY);
  const forced = forcedCollapse(mobile, bothFit);

  const [sideCollapsed, setSideCollapsed] = useState(forced.side);
  const [bottomCollapsed, setBottomCollapsed] = useState(forced.bottom);

  useEffect(() => {
    setSideCollapsed(forced.side);
    setBottomCollapsed(forced.bottom);
  }, [forced.side, forced.bottom]);

  return {
    mobile,
    sideCollapsed,
    bottomCollapsed,
    toggleSide: () => setSideCollapsed((v) => !v),
    closeSide: () => setSideCollapsed(true),
    toggleBottom: () => setBottomCollapsed((v) => !v),
    expandBottom: () => setBottomCollapsed(false),
  };
}
