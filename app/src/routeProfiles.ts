// The route profiles file (data/profiles.json): every activity's elevation every 100 m
// of distance, relative to its start, for the analytics elevation heatmap. Fetched the
// first time the analytics page needs it, validated, and kept for the session. Format:
// scripts/routeProfile.ts.

import type { ProfilesFile } from "./types";

/** Wire-format version this app understands (see scripts/routeProfile.ts). */
export const PROFILES_VERSION = 1;

export const PROFILES_URL = `${import.meta.env.BASE_URL}data/profiles.json`;

/** Validate a fetched profiles file: known version, a step, and every profile 2+ numbers. */
export function parseProfiles(json: unknown): ProfilesFile {
  if (json == null || typeof json !== "object") throw new Error("profiles file is not an object");
  const f = json as ProfilesFile;
  if (f.v !== PROFILES_VERSION) {
    throw new Error(`Unsupported profiles version ${String(f.v)} (expected ${PROFILES_VERSION})`);
  }
  if (!(typeof f.step === "number" && f.step > 0)) throw new Error("profiles file has no valid step");
  if (f.profiles == null || typeof f.profiles !== "object") throw new Error("profiles file has no profiles");
  for (const [id, p] of Object.entries(f.profiles)) {
    if (!Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite)) {
      throw new Error(`profile ${id} is not a list of 2 or more numbers`);
    }
  }
  return f;
}

let cached: Promise<ProfilesFile> | null = null;

/** Fetch and parse once. A failed load is forgotten, so the next visit retries. */
export function loadProfiles(fetchJson: (url: string) => Promise<unknown>): Promise<ProfilesFile> {
  if (!cached) {
    const p = fetchJson(PROFILES_URL).then(parseProfiles);
    p.catch(() => {
      if (cached === p) cached = null;
    });
    cached = p;
  }
  return cached;
}
