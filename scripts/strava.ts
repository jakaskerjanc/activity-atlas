// Strava API client: refresh-token -> access-token, and paged activity fetch.

import type { CachedActivity } from "./types.ts";

const STRAVA_OAUTH = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Exchange the long-lived refresh token for a short-lived access token. */
export async function getAccessToken(): Promise<string> {
  const res = await fetch(STRAVA_OAUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      refresh_token: requireEnv("STRAVA_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Token exchange returned no access_token");
  return json.access_token;
}

/** Raw shape of the fields we read from Strava's activity list response. */
interface RawActivity {
  id: number;
  name: string;
  type: string;
  sport_type?: string;
  start_date: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  map?: { summary_polyline?: string | null };
}

function toCached(a: RawActivity): CachedActivity {
  return {
    id: a.id,
    name: a.name,
    type: a.sport_type || a.type,
    start_date: a.start_date,
    distance: a.distance,
    moving_time: a.moving_time,
    total_elevation_gain: a.total_elevation_gain,
    summary_polyline: a.map?.summary_polyline ?? "",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StravaHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Give up waiting on 429s after this cumulative budget (covers a 15-min window
 *  reset, but bails instead of spinning for hours on daily-limit exhaustion). */
const MAX_RATELIMIT_WAIT_MS = 20 * 60 * 1000;

/**
 * GET a Strava API path with bearer auth, honoring 429 Retry-After (default 60s)
 * by waiting and retrying the same request, up to MAX_RATELIMIT_WAIT_MS total.
 * Throws StravaHttpError on any other non-2xx (or when the wait budget is spent).
 */
async function stravaGet(url: string, token: string): Promise<unknown> {
  let waitedMs = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) || 60;
      if (waitedMs + retry * 1000 > MAX_RATELIMIT_WAIT_MS) {
        throw new StravaHttpError(
          429,
          `Rate limited; exceeded ${MAX_RATELIMIT_WAIT_MS / 60000}min wait budget (${url})`,
        );
      }
      console.warn(`Rate limited; waiting ${retry}s...`);
      waitedMs += retry * 1000;
      await sleep(retry * 1000);
      continue; // retry same request
    }
    if (!res.ok) {
      throw new StravaHttpError(res.status, `Strava GET failed: ${res.status} ${await res.text()} (${url})`);
    }
    return res.json();
  }
}

/**
 * Fetch all activities started after `afterEpochSeconds`, ascending, paginated.
 */
export async function fetchActivitiesAfter(
  token: string,
  afterEpochSeconds: number,
): Promise<CachedActivity[]> {
  const perPage = 200;
  const out: CachedActivity[] = [];
  let page = 1;

  while (true) {
    const url =
      `${STRAVA_API}/athlete/activities` +
      `?after=${afterEpochSeconds}&per_page=${perPage}&page=${page}`;
    const batch = (await stravaGet(url, token)) as RawActivity[];
    if (batch.length === 0) break;
    out.push(...batch.map(toCached));
    if (batch.length < perPage) break; // last page
    page += 1;
  }

  return out;
}

/**
 * Fetch one activity's full-resolution route polyline via the detail endpoint.
 * Returns "" when the activity has no map (indoor / manual).
 */
export async function fetchActivityDetail(token: string, id: number): Promise<string> {
  try {
    const detail = (await stravaGet(`${STRAVA_API}/activities/${id}`, token)) as {
      map?: { polyline?: string | null };
    };
    return detail.map?.polyline ?? "";
  } catch (err) {
    if (err instanceof StravaHttpError && err.status === 404) {
      console.warn(`Activity ${id} not found on Strava (404); skipping.`);
      return "";
    }
    throw err;
  }
}
