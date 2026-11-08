// The daily step totals, as a load state, for the steps half of the activity calendar.
// Fetched once per session the first time the analytics page asks, so the map's first
// load doesn't grow by them.

import { useEffect, useState } from "react";
import { loadSteps } from "../steps";
import type { StepsFile } from "../types";

export type StepsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; file: StepsFile };

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r.json();
}

export function useSteps(): StepsState {
  const [state, setState] = useState<StepsState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    loadSteps(fetchJson).then(
      (file) => live && setState({ status: "ready", file }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
