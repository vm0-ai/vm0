#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
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
elif command -v pnpm >/dev/null 2>&1 && [ -d "${REPO_ROOT}/turbo/apps/host-worker" ]; then
  pnpm --dir "${REPO_ROOT}/turbo/apps/host-worker" exec wrangler "${args[@]}"
else
  npx --yes wrangler@4.91.0 "${args[@]}"
fi
