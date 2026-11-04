// The route profiles for the elevation heatmap, as a load state. Fetched once per session the
// first time a component asks (the analytics page), so the map's first load doesn't
// grow by them.

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

export function useRouteProfiles(): ProfilesState {
  const [state, setState] = useState<ProfilesState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    loadProfiles(fetchJson).then(
      (file) => live && setState({ status: "ready", file }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
