#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIFECYCLE_FILE="${LIFECYCLE_FILE:-${SCRIPT_DIR}/runner-r2-cache-lifecycle.json}"

if [ -z "${R2_RUNNER_CACHE_BUCKET_NAME:-}" ]; then
  echo "R2_RUNNER_CACHE_BUCKET_NAME is required" >&2
  exit 1
fi

args=(
  r2 bucket lifecycle set
  "$R2_RUNNER_CACHE_BUCKET_NAME"
  --file "$LIFECYCLE_FILE"
)

if [ -n "${R2_JURISDICTION:-}" ]; then
  args+=(--jurisdiction "$R2_JURISDICTION")
fi

if [ -n "${WRANGLER_BIN:-}" ]; then
  "$WRANGLER_BIN" "${args[@]}"
else
  npx --yes wrangler "${args[@]}"
fi
