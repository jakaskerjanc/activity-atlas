#!/usr/bin/env bash
# Live Garmin fetch -> rotate token -> commit DB. Real logic lives here so it
# runs identically locally. DRY_RUN=1 prints the mutating actions instead.
set -euo pipefail

DB="${DB:-data/activities.sqlite}"
DRY_RUN="${DRY_RUN:-0}"

run() {  # execute, or print under DRY_RUN
  if [ "$DRY_RUN" = "1" ]; then echo "DRY: $*"; else "$@"; fi
}

# 1. Fetch (fail-loud: a rejected token exits non-zero and fails the job).
"${PYTHON_BIN:-python3}" -m ingest.garmin_fetch --db "$DB"

# 2. Rotate FIRST — the refresh token rotates on use; once refreshed the old
#    one is dead, so the new blob must be persisted before anything else.
if [ -n "${GARMIN_TOKEN_OUT:-}" ] && [ -f "$GARMIN_TOKEN_OUT" ]; then
  if [ "$(cat "$GARMIN_TOKEN_OUT")" != "${GARMIN_TOKEN:-}" ]; then
    run gh secret set GARMIN_TOKEN < "$GARMIN_TOKEN_OUT"
  fi
fi

# 3. Commit + push only if the DB changed -> matches deploy.yml's path filter.
if git diff --quiet -- "$DB"; then
  echo "no DB change"
else
  git add "$DB"
  run git commit -m "chore: garmin fetch $(date -u +%F)"
  run git push
fi
