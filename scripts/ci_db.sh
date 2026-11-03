#!/usr/bin/env bash
# Prints the path of the database the site build should read, and only that
# path on stdout (logs go to stderr).
#   - R2 read-only token present: pull db/activities.sqlite from R2. A failed
#     pull fails the script, so a broken pull never publishes an empty site.
#   - else data/demo/activities.sqlite when present (template forks).
#   - else data/activities.sqlite, which may not exist: build-tracks then
#     writes an empty payload.
set -euo pipefail

DB="data/activities.sqlite"
DEMO="data/demo/activities.sqlite"

if [ -n "${R2_RO_ACCESS_KEY_ID:-}" ]; then
  mkdir -p "$(dirname "$DB")"
  AWS_ACCESS_KEY_ID="$R2_RO_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="${R2_RO_SECRET_ACCESS_KEY:?R2_RO_SECRET_ACCESS_KEY is not set}" \
  AWS_DEFAULT_REGION=auto \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
  AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws s3 cp "s3://${R2_BUCKET:?R2_BUCKET is not set}/db/activities.sqlite" "$DB" \
      --endpoint-url "https://${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is not set}.r2.cloudflarestorage.com" >&2
  echo "$DB"
elif [ -f "$DEMO" ]; then
  echo "no R2 secrets: building from the demo database" >&2
  echo "$DEMO"
else
  echo "::warning::no R2 secrets and no demo database: the site will be empty" >&2
  echo "$DB"
fi
