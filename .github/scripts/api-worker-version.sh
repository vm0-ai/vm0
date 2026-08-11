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

for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN; do
  require_env "$name"
done

worker_name=${CF_API_WORKER_NAME:-vm0-api-production}
api_origin=${CLOUDFLARE_API_ORIGIN:-https://api.cloudflare.com/client/v4}

cloudflare_api() {
  local method=$1
  local path=$2
  local data=${3:-}
  local args=(
    --request "$method"
    --fail-with-body
    --show-error
    --silent
    --max-time 60
    --retry 3
    --retry-delay 2
    --retry-all-errors
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
  )
  if [ -n "$data" ]; then
    args+=(
      -H 'Content-Type: application/json'
      --data "$data"
    )
  fi
  local response
  response=$(curl "${args[@]}" "${api_origin}${path}")
  jq -e '.success == true' <<<"$response" >/dev/null || {
    jq '{errors, messages}' <<<"$response" >&2
    fail "Cloudflare API request failed: ${method} ${path}"
  }
  printf '%s\n' "$response"
}

deployments() {
  cloudflare_api GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/deployments" |
    jq -ce '.result.deployments // []'
}

latest_deployment() {
  deployments | jq -c 'sort_by(.created_on) | reverse | .[0] // null'
}

create_deployment() {
  local versions_json=$1
  local message=$2
  local payload
  payload=$(jq -cn \
    --arg message "$message" \
    --argjson versions "$versions_json" \
    '{
      strategy: "percentage",
      versions: $versions,
      annotations: {"workers/message": $message}
    }')
  cloudflare_api POST \
    "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/deployments" \
    "$payload" >/dev/null
}

versions_for_target_commit() {
  require_env TARGET_COMMIT
  if [[ ! "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    fail "TARGET_COMMIT must be a full lowercase SHA-1: ${TARGET_COMMIT}"
  fi
  local response
  response=$(cloudflare_api GET \
    "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/versions?deployable=true")
  jq -ce --arg tag "$TARGET_COMMIT" '[
    (.result.items // [])[]
    | select(.annotations["workers/tag"] == $tag)
  ]' <<<"$response"
}

resolve_version() {
  local matches count
  matches=$(versions_for_target_commit)
  count=$(jq -r 'length' <<<"$matches")
  if [ "$count" -ne 1 ]; then
    fail "Expected exactly one deployable ${worker_name} version tagged ${TARGET_COMMIT}, found ${count}"
  fi
  jq -r '.[0].id' <<<"$matches"
}

resolve_optional_version() {
  local matches count
  matches=$(versions_for_target_commit)
  count=$(jq -r 'length' <<<"$matches")
  if [ "$count" -gt 1 ]; then
    fail "Expected at most one deployable ${worker_name} version tagged ${TARGET_COMMIT}, found ${count}"
  fi
  jq -r '.[0].id // empty' <<<"$matches"
}

verify_active_version() {
  require_env TARGET_VERSION_ID
  local expected_commit=${TARGET_COMMIT:-}
  local latest count version_id percentage
  latest=$(latest_deployment)
  [ "$latest" != "null" ] || fail "${worker_name} has no active deployment"
  count=$(jq -r '.versions | length' <<<"$latest")
  version_id=$(jq -r '.versions[0].version_id // empty' <<<"$latest")
  percentage=$(jq -r '.versions[0].percentage // empty' <<<"$latest")
  if [ "$count" -ne 1 ] || [ "$version_id" != "$TARGET_VERSION_ID" ] || [ "$percentage" != "100" ]; then
    fail "${worker_name} active deployment is not exactly ${TARGET_VERSION_ID} at 100%"
  fi
  if [ -n "$expected_commit" ]; then
    local version
    version=$(cloudflare_api GET \
      "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/versions/${TARGET_VERSION_ID}")
    jq -e --arg expected "$expected_commit" \
      '.result.annotations["workers/tag"] == $expected' <<<"$version" >/dev/null ||
      fail "${worker_name} version ${TARGET_VERSION_ID} is not tagged ${expected_commit}"
  fi
  echo "Verified ${worker_name} version ${TARGET_VERSION_ID} at 100%."
}

promote_version() {
  require_env TARGET_VERSION_ID
  create_deployment \
    "$(jq -cn --arg id "$TARGET_VERSION_ID" '[{version_id: $id, percentage: 100}]')" \
    "Promote ${TARGET_COMMIT:-$TARGET_VERSION_ID} to 100%"
  verify_active_version
}

command=${1:-}
case "$command" in
  resolve)
    resolve_version
    ;;
  resolve-optional)
    resolve_optional_version
    ;;
  promote)
    promote_version
    ;;
  verify-active)
    verify_active_version
    ;;
  *)
    fail "Usage: api-worker-version.sh resolve|resolve-optional|promote|verify-active"
    ;;
esac
