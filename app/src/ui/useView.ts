// Which page is open: the map or analytics. Kept in the URL hash so a reload, a shared
// link, and the browser's back/forward buttons all land on the same page.

import { useEffect, useState } from "react";

export type View = "map" | "analytics";

const ANALYTICS_HASH = "#analytics";

/** The page a location hash points at. Anything unrecognized is the map. */
export function viewFromHash(hash: string): View {
  return hash === ANALYTICS_HASH ? "analytics" : "map";
}

export function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash));

  // popstate covers back/forward and a hand-edited hash.
  useEffect(() => {
    const sync = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const go = (next: View) => {
    if (next === view) return;
    // The map is the bare URL, so its links stay clean. pushState doesn't fire popstate,
    // hence the explicit setView.
    const { pathname, search } = window.location;
    window.history.pushState(null, "", next === "map" ? pathname + search : ANALYTICS_HASH);
    setView(next);
  };

  return [view, go];
}
