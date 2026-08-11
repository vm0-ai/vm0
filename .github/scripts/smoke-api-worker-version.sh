#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    fail "Missing required environment variable: ${name}"
  fi
}

for name in \
  CF_ACCESS_CLIENT_ID \
  CF_ACCESS_CLIENT_SECRET \
  CF_API_PRODUCTION_CANDIDATE_ORIGIN \
  TARGET_COMMIT \
  TARGET_VERSION_ID; do
  require_env "$name"
done

if [[ ! "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "TARGET_COMMIT must be a full lowercase SHA-1: ${TARGET_COMMIT}"
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

unauthenticated_status=$(curl \
  --output /dev/null \
  --silent \
  --max-time 20 \
  --write-out '%{http_code}' \
  "${CF_API_PRODUCTION_CANDIDATE_ORIGIN%/}/api/internal/worker-readiness")
if [ "$unauthenticated_status" = "200" ]; then
  fail "Production Worker candidate readiness is reachable without Cloudflare Access"
fi

access_headers=(
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
)

ready=false
for attempt in $(seq 1 20); do
  status=$(curl \
    --output "${tmp_dir}/body.json" \
    --dump-header "${tmp_dir}/headers.txt" \
    --silent \
    --show-error \
    --max-time 60 \
    --write-out '%{http_code}' \
    "${access_headers[@]}" \
    "${CF_API_PRODUCTION_CANDIDATE_ORIGIN%/}/api/internal/worker-readiness" || true)
  if [ "$status" = "200" ] &&
    jq -e \
      --arg commit "$TARGET_COMMIT" \
      --arg version "$TARGET_VERSION_ID" \
      '
        .ok == true and
        .commitSha == $commit and
        .workerVersion == $version and
        .checks == {
          axiom: "ok",
          database: "ok",
          kms: "ok",
          r2: "ok"
        }
      ' "${tmp_dir}/body.json" >/dev/null &&
    tr -d '\r' <"${tmp_dir}/headers.txt" |
      grep -iq '^x-vm0-api-runtime: cloudflare-worker$'; then
    ready=true
    break
  fi
  echo "Worker candidate has not passed readiness (attempt ${attempt}/20, status ${status:-unavailable})"
  sleep 3
done

if [ "$ready" != "true" ]; then
  echo "Last readiness response:" >&2
  jq . "${tmp_dir}/body.json" >&2 2>/dev/null || true
  fail "Production Worker candidate did not pass readiness for ${TARGET_COMMIT} (${TARGET_VERSION_ID})"
fi

test_status=$(curl \
  --output /dev/null \
  --silent \
  --show-error \
  --max-time 20 \
  --write-out '%{http_code}' \
  "${access_headers[@]}" \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "${CF_API_PRODUCTION_CANDIDATE_ORIGIN%/}/api/test/worker-runtime/outbound-safety")
if [ "$test_status" != "404" ]; then
  fail "Production Worker exposed /api/test/* with status ${test_status}"
fi

echo "Production Worker candidate ${TARGET_VERSION_ID} passed readiness for ${TARGET_COMMIT}."
