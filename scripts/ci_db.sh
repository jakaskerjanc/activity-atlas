#!/usr/bin/env bash
# Prints the path of the database the site build should read, and only that
# path on stdout (logs go to stderr).
#   - R2_BUCKET or R2_RO_ACCESS_KEY_ID set: pull db/activities.sqlite from R2
#     with the read-only pair. Any missing R2 value, or a failed pull, fails
#     the script, so the owner's site is never published empty or as the demo.
#   - neither set: data/demo/activities.sqlite when present (forks).
#   - else data/activities.sqlite, which may not exist: build-tracks then
#     writes an empty payload.
set -euo pipefail

DB="data/activities.sqlite"
DEMO="data/demo/activities.sqlite"

if [ -n "${R2_BUCKET:-}" ] || [ -n "${R2_RO_ACCESS_KEY_ID:-}" ]; then
  # R2 is configured (at least partly): never fall back to the demo/empty
  # site, or an incomplete secret set would silently publish the wrong data.
  missing=""
  for name in R2_ACCOUNT_ID R2_BUCKET R2_RO_ACCESS_KEY_ID R2_RO_SECRET_ACCESS_KEY; do
    [ -n "${!name:-}" ] || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    echo "::error::R2 is configured but these secrets are missing:$missing" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DB")"
  AWS_ACCESS_KEY_ID="$R2_RO_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_RO_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION=auto \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
  AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws s3 cp "s3://$R2_BUCKET/db/activities.sqlite" "$DB" \
      --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" >&2
  echo "$DB"
elif [ -f "$DEMO" ]; then
  echo "no R2 secrets: building from the demo database" >&2
  echo "$DEMO"
else
  echo "::warning::no R2 secrets and no demo database: the site will be empty" >&2
  echo "$DB"
fi
