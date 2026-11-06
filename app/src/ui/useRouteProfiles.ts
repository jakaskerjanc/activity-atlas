// The route profiles, as a load state: for the elevation profiles chart, and for the
// map's Grade color mode (grade along each route). Fetched once per session the
// first time a component asks (the analytics page, or picking Elevation), so the map's
// first load doesn't grow by them.

import { useEffect, useState } from "react";
import { loadProfiles } from "../routeProfiles";
import type { ProfilesFile } from "../types";

export type ProfilesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; file: ProfilesFile };

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r.json();
}

/** `enabled` false holds off the fetch; a file already loaded stays ready. */
export function useRouteProfiles(enabled = true): ProfilesState {
  const [state, setState] = useState<ProfilesState>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadProfiles(fetchJson).then(
      (file) => live && setState({ status: "ready", file }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return state;
}
