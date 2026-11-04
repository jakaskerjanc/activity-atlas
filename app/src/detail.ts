// Per-activity detail files (data/activity/<id>.json): fetched when an activity is
// selected, validated, and kept for the session. Format: scripts/detail.ts.

import type { DetailFile } from "./types";

/** Wire-format version this app understands (see scripts/detail.ts). */
export const DETAIL_VERSION = 1;

const SERIES_KEYS = ["d", "lat", "lon", "alt", "hr", "speed", "cad"] as const;

export type DetailState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; detail: DetailFile };

export function detailUrl(id: string): string {
  return `${import.meta.env.BASE_URL}data/activity/${id}.json`;
}

/** Validate a fetched detail file: known version, and every series as long as `t`. */
export function parseDetail(json: unknown): DetailFile {
  if (json == null || typeof json !== "object") throw new Error("detail file is not an object");
  const d = json as DetailFile;
  if (d.v !== DETAIL_VERSION) {
    throw new Error(`Unsupported detail version ${String(d.v)} (expected ${DETAIL_VERSION})`);
  }
  if (!Array.isArray(d.t)) throw new Error("detail file has no t series");
  for (const k of SERIES_KEYS) {
    const s = d[k];
    if (s !== undefined && (!Array.isArray(s) || s.length !== d.t.length)) {
      throw new Error(`detail series ${k} does not match t (${d.t.length} points)`);
    }
  }
  return d;
}

const cache = new Map<string, Promise<DetailFile>>();

/** Fetch and parse once per id. A failed load is forgotten, so the next open retries. */
export function loadDetail(
  id: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<DetailFile> {
  let p = cache.get(id);
  if (!p) {
    p = fetchJson(detailUrl(id)).then(parseDetail);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
