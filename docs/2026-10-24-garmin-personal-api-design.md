# Design: Garmin live fetch on the official Personal API

Date: 2026-10-24
Status: approved (design)
Issue: [#22](https://github.com/jakaskerjanc/strava-on-maps/issues/22)

## Problem

The daily fetch (`.github/workflows/fetch-garmin.yml` → `scripts/ci_fetch.sh` →
`ingest/garmin_fetch.py`) depends on the unofficial `garminconnect` library and
`curl_cffi`. It logs in as a user (email + password + MFA), stores a rotating
token blob in `GARMIN_TOKEN`, and calls undocumented Garmin Connect endpoints.
Garmin now offers an official Personal API. Replace the transport and auth
without changing the store or wire-format contract.

## Verified API facts (2026-10-24)

Sources:

- <https://developer.garmin.com/gc-developer-program/personal/personal-api/>
- <https://developer.garmin.com/gc-developer-program/personal/personal-faq/>
- <https://developer.garmin.com/gc-developer-program/personal/swagger-docs/>
- <https://github.com/garmin/connect-personal-api-python>

| Concern | Fact |
|---|---|
| Base URL | `https://personal.connectapi.garmin.com` |
| Key creation | Garmin Connect → Settings → Personal API Key; shown once |
| Key lifetime | 30 / 90 / 180 / 365 days, chosen at creation |
| Token exchange | `POST /personalapitoken-service/personal-api/personal-api-key/token`, header `Authorization: ApiKey <key>` |
| Token response | Raw JWT text (not JSON), valid 24 h |
| Refresh tokens | Not supported; exchange the key again |
| Activity list | `GET /activitylist-service/activities/search/activities?start=&limit=` |
| Activity download | `GET /download-service/files/activity/{activityId}` → ZIP with the original FIT/TCX/GPX |
| Activity detail | `GET /activity-service/activity/{activityId}` exists, but no polyline |
| Old detail endpoint | `/activity-service/activity/{id}/details` is **not** in the Personal API Swagger |
| Rate limits | Not documented publicly |

The list response (`SummarizedActivityDTO`) already contains every scalar the
pipeline maps today: `activityId`, `activityName`, `activityType.typeKey`,
`startTimeGMT` (`YYYY-MM-DD HH:MM:SS`, UTC), `distance` (m), `duration` and
`movingDuration` (s), `elevationGain` (m), and `hasPolyline`. Unlike the bulk
export's `summarizedActivities.json` (cm / ms), these values are already in
meters and seconds — **no scaling**.

The downloaded original file is the geometry source. It also carries per-point
altitude (FIT `altitude` / `enhanced_altitude`, GPX `ele`, TCX
`AltitudeMeters`), so issues #16/#17 keep their capture path even though
per-point elevation is out of scope here.

## Architecture

```
Personal API key ──POST──▶ bearer token (24 h)
                              │
GET activity list (paged, newest first) ──▶ metadata
                              │
       hasPolyline? ──yes──▶ GET activity ZIP ──▶ FIT/TCX/GPX parser ──▶ track
                              │
                              ▼
                    RawActivity → normalize → dedupe → store   (unchanged)
```

Files:

- **New** `ingest/garmin_api.py` — stdlib-only client:
  - credential resolution: explicit key → explicit key file →
    `GARMIN_PERSONAL_API_KEY` → `~/.config/garmin/connect-personal-api-key`
  - token exchange, JSON GET, ZIP download
  - typed errors: `MissingApiKey`, `GarminAuthError`, `GarminApiError`
- **Rewrite** `ingest/garmin_fetch.py`:
  - keeps `gmt_to_dt`, `filter_after`, `list_item_to_raw`, high-water windowing
    and the `RawActivity` contract
  - adds `extract_track_from_zip()`: prefers `.fit`, then `.tcx`, then `.gpx`,
    reusing `ingest/parse/*`
  - list fields remain authoritative for metadata; only geometry comes from
    the ZIP
- **Delete** `ingest/garmin_auth.py`; key creation is a one-time web step
- **CI** `scripts/ci_fetch.sh`: fetch → commit DB → push; no token rotation
- **Workflow**: `GARMIN_PERSONAL_API_KEY` replaces `GARMIN_TOKEN`; `GH_PAT`
  stays only so the push retriggers `deploy.yml`
- **Dependencies**: remove `garminconnect` and `curl_cffi`; add nothing

## Credentials

Local:

1. `--api-key-file PATH`
2. `GARMIN_PERSONAL_API_KEY`
3. `~/.config/garmin/connect-personal-api-key` (recommended, `chmod 600`)

An explicitly selected key file that is missing or empty is an error; it does
not fall back to the environment or default file.

CI:

- `GARMIN_PERSONAL_API_KEY` repository secret.
- Each run exchanges the key for a fresh 24 h token. There is no token to
  rotate and no `gh secret set`.
- `GH_PAT` remains a fine-grained token with **contents: write** only. Its
  `secrets: write` permission is no longer needed.

Failure modes:

- Missing key → exit 2 with instructions.
- Rejected/expired key → exit 3 with instructions to create a new key.
- Other HTTP/network errors → fail the run.
- Download/parse failure → warn, skip that activity, retry next run; three
  consecutive failures stop the run.
- Auth error during a download → abort the run.

## Data contract

Keep exactly the current fields. No schema, wire-format, or UI changes.

| Store column | API source | Notes |
|---|---|---|
| `id` | derived `g:<activityId>` | canonical id, unchanged on merge |
| `garmin_id` | `activityId` | exact-id dedupe key |
| `strava_id` | — | filled only by a cross-source merge |
| `name` | `activityName` | `""` fallback |
| `type` | `activityType.typeKey` → `canonical_type()` | `"other"` fallback |
| `start_time` | `startTimeGMT` | parse as UTC, store ISO-8601 |
| `distance` | `distance` | meters, no scaling |
| `moving_time` | `movingDuration`, fallback `duration` | seconds, no scaling |
| `elevation_gain` | `elevationGain` | meters |
| `polyline` | ZIP track | 0.5 m simplify, precision-5 |
| `start_lat` / `start_lng` | first track point | `null` when no GPS |

`tracks.json` keeps the same subset as today: `id`, `name`, `type`, `ts`,
`start_date`, `distance`, `moving_time`, `elevation_gain`, `poly`.

Deliberately dropped (available from the list or the original file): per-point
altitude/time/HR/cadence/power/temperature, laps, description, location,
UUID/event/privacy fields, elapsed duration, elevation loss/min/max, speed
stats, calories, training effect, splits, device/media data. Each would require
a schema, wire, and UI decision and belongs in a separate issue.

## Testing

- `ingest/tests/test_garmin_api.py`: credential precedence, token request
  headers, bearer list/download requests, typed HTTP errors.
- `ingest/tests/test_garmin_fetch.py`: ZIP selection and parsing (FIT and TCX
  fixtures), list mapping/units/fallbacks, high-water rerun, download-failure
  skip/retry, auth exit codes.
- `ingest/tests/test_ci_fetch.py`: commit/push only when the DB changes, no
  token rotation, fetch failure aborts.
- `ingest/tests/test_base.py`: missing credentials still exit 2 without
  touching the network.
- Live verification with the real key on a copy of the committed DB:
  two runs, no duplicates, fields and geometry match the existing row.

## Risks and limitations

- **Historical scope.** Some Garmin material says the Personal API serves
  current rather than full historical activity data. Incremental fetch only
  needs recent activities, so this does not affect the pipeline; the committed
  DB remains the history.
- **Key expiry.** The key is not permanent. CI fails loudly with exit 3; the
  README documents renewal.
- **Undocumented rate limits.** The fetch keeps the 1 req/s delay and downloads
  files only for new GPS activities.
- **Polyline differences.** The old scraper used Garmin's detail polyline; the
  new path parses the original file. The route is the same but the point set
  can be denser. Import-time 0.5 m simplification keeps the store compact.
- **High-water mark.** `BaseFetcher.high_water()` remains the global
  `MAX(start_time)` across all sources, with the existing accepted limitation.
- **First-run dedupe.** Garmin `activityId` values are unchanged, so existing
  `g:<id>` rows match exactly and no duplicates are created.
- **Contract gate.** If the live probe shows the download does not contain
  usable GPS for activities flagged `hasPolyline`, stop and revisit before
  merging.

## Coordination

- Bulk export import (`npm run import:garmin`) is unchanged and remains the
  backfill path.
- #16/#17 need per-point elevation. The downloaded original file contains it
  in all three formats; the existing parsers already have access to it. No
  API-specific work is needed for those issues.
- `GH_PAT` keeps its push role; only `secrets: write` becomes unnecessary.

## Acceptance criteria mapping

- Daily CI fetch on the official API with no `garminconnect` dependency:
  tasks 1–3.
- Newly fetched activities match scraper fields and dedupe cleanly: task 5
  live verification.
- Docs and secrets setup updated; full suite passes: task 4.
