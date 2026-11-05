// The city distances, as a load state: for the analytics page's distance comparisons and
// the city route on the map. Fetched once per session the first time either needs it, so
// the map's first load doesn't grow by them.

import { useEffect, useState } from "react";
import { loadCities, type CityData } from "../cities";

export type CitiesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: CityData };

/** `enabled` false holds off the fetch; a dataset already loaded stays ready. */
export function useCities(enabled = true): CitiesState {
  const [state, setState] = useState<CitiesState>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadCities().then(
      (data) => live && setState({ status: "ready", data }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}
