// routes.json, as a load state. Fetched once at mount, alongside activities.json but
// not waited for: Analytics and Activities show as soon as the activities are in, and
// only the map (and the Activities page's track sketches) needs the routes.

import { useEffect, useState } from "react";
import type { RoutesFile } from "../types";

export const ROUTES_URL = `${import.meta.env.BASE_URL}data/routes.json`;

export type RoutesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: RoutesFile };

export function useRoutes(): RoutesState {
  const [state, setState] = useState<RoutesState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetch(ROUTES_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${ROUTES_URL}: ${r.status} ${r.statusText}`);
        return r.json() as Promise<RoutesFile>;
      })
      .then(
        (file) => live && setState({ status: "ready", file }),
        (e: unknown) => live && setState({ status: "error", message: String(e) }),
      );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
