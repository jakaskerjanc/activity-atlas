// The route profiles for the ridgeline, as a load state. Fetched once per session the
// first time a component asks (the analytics page), so the map's first load doesn't
// grow by them.

import { useEffect, useState } from "react";
import { loadProfiles } from "../routeProfiles";

export type ProfilesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profiles: Record<string, number[]> };

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
      (f) => live && setState({ status: "ready", profiles: f.profiles }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
