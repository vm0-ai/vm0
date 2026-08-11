#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

for name in TARGET_COMMIT VERCEL_DEPLOYMENT_URL; do
  if [ -z "${!name:-}" ]; then
    fail "Missing required environment variable: ${name}"
  fi
done
if [[ ! "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "TARGET_COMMIT must be a full lowercase SHA-1: ${TARGET_COMMIT}"
fi

headers=(
  -H 'User-Agent: vm0-production-smoke'
)
if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
  headers+=(
    -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}"
  )
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

curl \
  --fail \
  --show-error \
  --silent \
  --max-time 30 \
  --retry 10 \
  --retry-delay 3 \
  --retry-all-errors \
  --dump-header "${tmp_dir}/headers.txt" \
  --output "${tmp_dir}/build-info.json" \
  "${headers[@]}" \
  "${VERCEL_DEPLOYMENT_URL%/}/api/build-info"
jq -e --arg commit "$TARGET_COMMIT" '.commitSha == $commit' \
  "${tmp_dir}/build-info.json" >/dev/null ||
  fail "Vercel candidate build-info does not match ${TARGET_COMMIT}"
if ! tr -d '\r' <"${tmp_dir}/headers.txt" |
  grep -iq '^x-vm0-api-runtime: vercel$'; then
  fail "Vercel candidate did not identify itself as the Vercel runtime"
fi

curl \
  --fail \
  --show-error \
  --silent \
  --max-time 30 \
  --retry 5 \
  --retry-delay 2 \
  --retry-all-errors \
  "${headers[@]}" \
  "${VERCEL_DEPLOYMENT_URL%/}/health" >/dev/null

test_status=$(curl \
  --output /dev/null \
  --silent \
  --show-error \
  --max-time 20 \
  --write-out '%{http_code}' \
  "${headers[@]}" \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "${VERCEL_DEPLOYMENT_URL%/}/api/test/worker-runtime/outbound-safety")
if [ "$test_status" != "404" ]; then
  fail "Vercel production candidate exposed /api/test/* with status ${test_status}"
fi

echo "Vercel candidate passed readiness for ${TARGET_COMMIT}."
