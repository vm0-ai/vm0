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
  CLOUDFLARE_ACCOUNT_ID \
  CLOUDFLARE_API_TOKEN \
  VERCEL_ORG_ID \
  VERCEL_PROJECT_ID \
  VERCEL_TOKEN; do
  require_env "$name"
done

worker_name=${CF_API_WORKER_NAME:-vm0-api-production}
api_hostname=${CF_API_PUBLIC_HOSTNAME:-api.vm0.ai}
cf_api_origin=${CLOUDFLARE_API_ORIGIN:-https://api.cloudflare.com/client/v4}
vercel_api_origin=${VERCEL_API_ORIGIN:-https://api.vercel.com}

cf_get() {
  local path=$1
  local response
  response=$(curl \
    --request GET \
    --fail-with-body \
    --show-error \
    --silent \
    --max-time 60 \
    --retry 3 \
    --retry-delay 2 \
    --retry-all-errors \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "${cf_api_origin}${path}")
  jq -e '.success == true' <<<"$response" >/dev/null ||
    fail "Cloudflare API request failed: ${path}"
  printf '%s\n' "$response"
}

vercel_deployment=$(curl \
  --request GET \
  --fail-with-body \
  --show-error \
  --silent \
  --max-time 60 \
  --retry 3 \
  --retry-delay 2 \
  --retry-all-errors \
  -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  "${vercel_api_origin}/v13/deployments/${api_hostname}?teamId=${VERCEL_ORG_ID}")

vercel_commit=$(jq -r '.meta.githubCommitSha // empty' <<<"$vercel_deployment")
vercel_url=$(jq -r '.url // empty' <<<"$vercel_deployment")
if [ "$(jq -r '.projectId // empty' <<<"$vercel_deployment")" != "$VERCEL_PROJECT_ID" ] ||
  [ "$(jq -r '.target // empty' <<<"$vercel_deployment")" != "production" ] ||
  [ "$(jq -r '.readyState // empty' <<<"$vercel_deployment")" != "READY" ] ||
  [[ ! "$vercel_commit" =~ ^[0-9a-f]{40}$ ]] ||
  [ -z "$vercel_url" ]; then
  fail "Vercel production alias ${api_hostname} did not resolve to a READY API deployment with a full commit SHA"
fi

latest_deployment=$(cf_get \
  "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/deployments" |
  jq -c '.result.deployments | sort_by(.created_on) | reverse | .[0] // null')
if [ "$latest_deployment" = "null" ]; then
  fail "${worker_name} has no active deployment"
fi
if [ "$(jq -r '.versions | length' <<<"$latest_deployment")" -ne 1 ] ||
  [ "$(jq -r '.versions[0].percentage // empty' <<<"$latest_deployment")" != "100" ]; then
  fail "${worker_name} must have exactly one active version at 100%"
fi
worker_version_id=$(jq -r '.versions[0].version_id' <<<"$latest_deployment")
worker_version=$(cf_get \
  "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}/versions/${worker_version_id}")
worker_commit=$(jq -r '.result.annotations["workers/tag"] // empty' <<<"$worker_version")

if [ "$worker_commit" != "$vercel_commit" ]; then
  fail "API production runtimes differ: Vercel=${vercel_commit}, Worker=${worker_commit:-untagged}"
fi
if [ -n "${EXPECTED_COMMIT:-}" ] && [ "$vercel_commit" != "$EXPECTED_COMMIT" ]; then
  fail "API production runtimes are at ${vercel_commit}, expected ${EXPECTED_COMMIT}"
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

vercel_curl_args=(
  --fail
  --show-error
  --silent
  --max-time 30
  --retry 5
  --retry-delay 2
  --retry-all-errors
  --dump-header "${tmp_dir}/vercel.headers"
  --output "${tmp_dir}/vercel.json"
)
if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
  vercel_curl_args+=(
    -H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}"
  )
fi
curl "${vercel_curl_args[@]}" \
  "https://${vercel_url}/api/build-info"
jq -e --arg commit "$vercel_commit" '.commitSha == $commit' \
  "${tmp_dir}/vercel.json" >/dev/null ||
  fail "Vercel production deployment build-info does not match ${vercel_commit}"
if ! tr -d '\r' <"${tmp_dir}/vercel.headers" |
  grep -iq '^x-vm0-api-runtime: vercel$'; then
  fail "Vercel production deployment did not identify itself as the Vercel runtime"
fi

curl \
  --fail \
  --show-error \
  --silent \
  --max-time 30 \
  --retry 5 \
  --retry-delay 2 \
  --retry-all-errors \
  --dump-header "${tmp_dir}/worker.headers" \
  --output "${tmp_dir}/worker.json" \
  -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
  -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
  "${CF_API_PRODUCTION_CANDIDATE_ORIGIN%/}/api/build-info"
jq -e --arg commit "$worker_commit" '.commitSha == $commit' \
  "${tmp_dir}/worker.json" >/dev/null ||
  fail "Worker production deployment build-info does not match ${worker_commit}"
if ! tr -d '\r' <"${tmp_dir}/worker.headers" |
  grep -iq '^x-vm0-api-runtime: cloudflare-worker$'; then
  fail "Worker production deployment did not identify itself as the Worker runtime"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "target_commit=${vercel_commit}"
    echo "vercel_deployment_url=https://${vercel_url}"
    echo "worker_version_id=${worker_version_id}"
  } >>"$GITHUB_OUTPUT"
fi

echo "Verified Vercel and ${worker_name} at ${vercel_commit}."
