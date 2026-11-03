#!/usr/bin/env bash
# Daily Garmin fetch into R2. The R2_BUCKET gate below reads the process
# environment only (not the repo-root .env); in CI the secrets arrive as env
# vars. Nothing is committed: the database lives in R2, and the writer reports
# whether it changed through $GITHUB_OUTPUT (db_changed=true|false).
set -euo pipefail

DB="${DB:-data/activities.sqlite}"

if [ -z "${R2_BUCKET:-}" ]; then
  if [ -n "${GARMIN_PERSONAL_API_KEY:-}" ]; then
    echo "::warning::GARMIN_PERSONAL_API_KEY is set but R2 is not configured: the fetch is skipped"
  else
    echo "::notice::no R2 secrets: the daily fetch needs R2"
  fi
  exit 0
fi

# Force the R2 archive: with an incomplete credential set, open_archive then
# raises instead of falling back to a local archive that dies with the runner.
export ARCHIVE_URL="r2://$R2_BUCKET"

# Fail-loud: a rejected key exits non-zero and fails the job.
"${PYTHON_BIN:-python3}" -m ingest.garmin_fetch --db "$DB"
