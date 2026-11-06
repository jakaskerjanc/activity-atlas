# Publishing your own data

The database is never committed to git, so the deploy reads it from a private
Cloudflare R2 bucket. Without R2 everything stays local (`data/archive/`,
`data/activities.sqlite`) and the site deploys the demo data.

## 1. Set up the R2 bucket

1. In the Cloudflare dashboard, create a private R2 bucket.
2. Create two R2 API tokens scoped to that bucket: one with **Object Read &
   Write** (your machine and the Garmin fetch) and one with **Object Read
   only** (the deploy and the MCP server).
3. Put them in `.env` (names are in `.example.env`).
4. Run the first import with `--init-db`; no other command creates the
   database in R2:

   ```bash
   pnpm run import:strava <strava-export.zip> --init-db
   pnpm run import:garmin <garmin-export.zip>
   ```

With the read-write names set, every writer (imports, `fetch:garmin`,
`rebuild`, `activity`) pulls the database from R2, changes it and uploads it
back only if it changed. A concurrent writer is never overwritten: the upload
is conditional on the version that was pulled, and the run retries against the
newer one. `data/activities.sqlite` is then a synced copy; refresh it with
`pnpm run sync`.

After deleting or recreating anything in the bucket, delete
`data/cache/<bucket>/` too, or the local cache skips re-uploading those keys.

## 2. Add the GitHub secrets

Add each value without putting it in shell history, and paste at the prompt:

```bash
gh secret set R2_ACCOUNT_ID
```

| Secret | Used by |
| --- | --- |
| `VITE_MAPBOX_TOKEN` | deploy |
| `R2_ACCOUNT_ID`, `R2_BUCKET` | deploy, fetch |
| `R2_RO_ACCESS_KEY_ID`, `R2_RO_SECRET_ACCESS_KEY` | deploy (reads the database) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | fetch (writes the database) |
| `GARMIN_PERSONAL_API_KEY` | fetch |

`deploy.yml` picks the database with `scripts/ci_db.sh`. With R2 secrets it
pulls the database, and a missing secret or failed pull fails the deploy, so
the site is never published empty or as the demo by mistake. Without R2
secrets it builds from the demo database.

## 3. Keep it current: the Garmin fetch

`ingest/garmin_fetch.py` pulls new activities and daily wellness data through
Garmin's official
[Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/).
It needs one API key, no password or MFA login.

1. Garmin Connect → **Settings** → **Personal API Key**. Pick a lifetime (30,
   90, 180 or 365 days) and copy the key; Garmin shows it only once.
2. Put it in `.env` as `GARMIN_PERSONAL_API_KEY` and run
   `pnpm run fetch:garmin`.

Each run re-checks the last 30 days: changed activities are updated, ones
Garmin no longer lists are marked deleted (never removed), and a failed
download writes nothing and is retried on the next run. Wellness data is
stored in the database and never published. `pnpm run fetch:garmin --help`
lists the backfill options (`--wellness-since`, `--wellness-until`).

Limits of the API: stress and respiration are daily figures only, and the
intraday series (heart rate through the day, HRV) are served for only about
the last 4 months, so a long gap loses its intraday detail.

### In CI

`.github/workflows/fetch-garmin.yml` runs daily, fetches into the R2 database
and, if it changed, calls `deploy.yml` to publish. It needs
`GARMIN_PERSONAL_API_KEY` and the R2 secrets, and is skipped with a notice
without the R2 ones.

### Renewing the key

When the key expires the daily fetch fails. Create a new one as above, update
`.env` and replace the secret:

```bash
gh secret set GARMIN_PERSONAL_API_KEY
```
