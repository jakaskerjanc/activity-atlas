// Reactive CSS media query. Used to decide whether a panel is rendered at all: the
// liquid-glass material is expensive to build and, in "shader" mode, crashes at zero
// size (see SidePanel) — so a panel that a stylesheet would hide must not be mounted.

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  // Read synchronously on first render so the initial paint already agrees with what
  // the stylesheet would do; no flash of a panel that is about to be hidden.
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
