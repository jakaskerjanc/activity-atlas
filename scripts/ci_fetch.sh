#!/usr/bin/env bash
# Daily Garmin fetch into R2. The Personal API key and the R2_* names are read
# from the environment (or the repo-root .env, by the writer). Nothing is
# committed: the database lives in R2, and the writer reports whether it
# changed through $GITHUB_OUTPUT (db_changed=true|false).
set -euo pipefail

DB="${DB:-data/activities.sqlite}"

if [ -z "${R2_BUCKET:-}" ]; then
  echo "::notice::no R2 secrets: the daily fetch needs R2"
  exit 0
fi

# Fail-loud: a rejected key exits non-zero and fails the job.
"${PYTHON_BIN:-python3}" -m ingest.garmin_fetch --db "$DB"
