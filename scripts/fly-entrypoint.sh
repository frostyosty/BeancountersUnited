#!/bin/sh
# The container's entrypoint on Fly (ADR 008). It brings back the database from the bucket if the
# volume is empty, then runs acctd under Litestream, which streams every change to the bucket.
set -eu

DB="${ACCT_DB:-/data/acct.db}"

if [ -z "${BUCKET_NAME:-}" ]; then
  if [ "${ACCT_REQUIRE_BACKUP:-0}" = "1" ]; then
    echo "BUCKET_NAME isn't set, so there's nowhere to back up to; not starting (ADR 008)" >&2
    exit 1
  fi
  echo "warning: BUCKET_NAME isn't set; running acctd without continuous backup" >&2
  exec acctd
fi

# Only restores onto an empty volume, and does nothing when the bucket is empty too (a new app).
litestream restore -if-db-not-exists -if-replica-exists "$DB"

exec litestream replicate -exec acctd
