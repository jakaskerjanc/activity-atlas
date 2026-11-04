// The selected activity's detail file, as a load state. Keyed by id, so a slow
// response for a previous selection never shows under the current one.

import { useEffect, useState } from "react";
import { loadDetail, type DetailState } from "../detail";

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r.json();
}

export function useActivityDetail(id: string | null, hasDetail: boolean): DetailState {
  const [loaded, setLoaded] = useState<{ id: string; state: DetailState } | null>(null);

  useEffect(() => {
    if (id == null || !hasDetail) return;
    let live = true;
    loadDetail(id, fetchJson).then(
      (detail) => live && setLoaded({ id, state: { status: "ready", detail } }),
      () => live && setLoaded({ id, state: { status: "error" } }),
    );
    return () => {
      live = false;
    };
  }, [id, hasDetail]);

  if (id == null || !hasDetail) return { status: "none" };
  return loaded?.id === id ? loaded.state : { status: "loading" };
}
