#!/usr/bin/env bash
# Live Garmin fetch -> commit DB. The Personal API key is read from
# GARMIN_PERSONAL_API_KEY, from the environment or the repo-root .env. Real
# logic lives here so it runs identically locally. DRY_RUN=1 prints the
# mutating actions instead.
set -euo pipefail

DB="${DB:-data/activities.sqlite}"
DRY_RUN="${DRY_RUN:-0}"

run() {  # execute, or print under DRY_RUN
  if [ "$DRY_RUN" = "1" ]; then echo "DRY: $*"; else "$@"; fi
}

# 1. Fetch (fail-loud: a rejected key exits non-zero and fails the job).
"${PYTHON_BIN:-python3}" -m ingest.garmin_fetch --db "$DB"

# 2. Commit + push only if the DB changed -> matches deploy.yml's path filter.
if git diff --quiet -- "$DB"; then
  echo "no DB change"
else
  run git add "$DB"
  run git commit -m "chore: garmin fetch $(date -u +%F)"
  run git push
fi
