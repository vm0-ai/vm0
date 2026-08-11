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
  CF_API_PUBLIC_HOSTNAME \
  CF_ZONE_ID \
  CLOUDFLARE_API_TOKEN \
  EXPECTED_COMMIT \
  TARGET_RUNTIME; do
  require_env "$name"
done

case "$TARGET_RUNTIME" in
  cloudflare|vercel) ;;
  *) fail "TARGET_RUNTIME must be cloudflare or vercel" ;;
esac
if [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "EXPECTED_COMMIT must be a full lowercase SHA-1: ${EXPECTED_COMMIT}"
fi

worker_name=${CF_API_WORKER_NAME:-vm0-api-production}
api_origin=${CLOUDFLARE_API_ORIGIN:-https://api.cloudflare.com/client/v4}
route_pattern="${CF_API_PUBLIC_HOSTNAME}/*"

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

resolve_dns_record() {
  local response records count
  response=$(cloudflare_api GET \
    "/zones/${CF_ZONE_ID}/dns_records?name=${CF_API_PUBLIC_HOSTNAME}")
  records=$(jq -ce --arg name "$CF_API_PUBLIC_HOSTNAME" '[
    .result[]
    | select(.name == $name and .proxiable == true)
  ]' <<<"$response")
  count=$(jq -r 'length' <<<"$records")
  if [ "$count" -ne 1 ]; then
    fail "Expected exactly one proxiable DNS record for ${CF_API_PUBLIC_HOSTNAME}, found ${count}"
  fi
  printf '%s\n' "$records" | jq -ce '.[0]'
}

matching_route() {
  local response routes count
  response=$(cloudflare_api GET "/zones/${CF_ZONE_ID}/workers/routes")
  routes=$(jq -ce --arg pattern "$route_pattern" '[
    .result[] | select(.pattern == $pattern)
  ]' <<<"$response")
  count=$(jq -r 'length' <<<"$routes")
  if [ "$count" -gt 1 ]; then
    fail "Found duplicate Worker Routes for ${route_pattern}"
  fi
  printf '%s\n' "$routes" | jq -c '.[0] // null'
}

set_dns_proxy() {
  local desired=$1
  local record record_id current response
  record=$(resolve_dns_record)
  record_id=$(jq -r '.id' <<<"$record")
  current=$(jq -r '.proxied' <<<"$record")
  if [ "$current" = "$desired" ]; then
    echo "DNS proxy state is already ${desired} for ${CF_API_PUBLIC_HOSTNAME}."
    return
  fi
  response=$(cloudflare_api PATCH \
    "/zones/${CF_ZONE_ID}/dns_records/${record_id}" \
    "$(jq -cn --argjson proxied "$desired" '{proxied: $proxied}')")
  jq -e --argjson desired "$desired" \
    '.result.proxied == $desired' <<<"$response" >/dev/null ||
    fail "Cloudflare did not set DNS proxied=${desired} for ${CF_API_PUBLIC_HOSTNAME}"
  echo "Set DNS proxied=${desired} for ${CF_API_PUBLIC_HOSTNAME}."
}

ensure_worker_route() {
  local route response
  route=$(matching_route)
  if [ "$route" != "null" ]; then
    if [ "$(jq -r '.script // empty' <<<"$route")" != "$worker_name" ]; then
      fail "Worker Route ${route_pattern} belongs to an unexpected script"
    fi
    echo "Worker Route ${route_pattern} already targets ${worker_name}."
    return
  fi
  response=$(cloudflare_api POST \
    "/zones/${CF_ZONE_ID}/workers/routes" \
    "$(jq -cn \
      --arg pattern "$route_pattern" \
      --arg script "$worker_name" \
      '{pattern: $pattern, script: $script}')")
  jq -e \
    --arg pattern "$route_pattern" \
    --arg script "$worker_name" \
    '.result.pattern == $pattern and .result.script == $script' \
    <<<"$response" >/dev/null ||
    fail "Cloudflare did not create Worker Route ${route_pattern}"
  echo "Created Worker Route ${route_pattern} -> ${worker_name}."
}

remove_worker_route() {
  local route route_id
  route=$(matching_route)
  if [ "$route" = "null" ]; then
    echo "Worker Route ${route_pattern} is already absent."
    return
  fi
  if [ "$(jq -r '.script // empty' <<<"$route")" != "$worker_name" ]; then
    fail "Refusing to delete Worker Route ${route_pattern} owned by another script"
  fi
  route_id=$(jq -r '.id' <<<"$route")
  cloudflare_api DELETE "/zones/${CF_ZONE_ID}/workers/routes/${route_id}" >/dev/null
  echo "Deleted Worker Route ${route_pattern}."
}

wait_for_runtime() {
  local expected=$1
  local tmp_dir status runtime commit
  tmp_dir=$(mktemp -d)
  for attempt in $(seq 1 60); do
    status=$(curl \
      --output "${tmp_dir}/body.json" \
      --dump-header "${tmp_dir}/headers.txt" \
      --silent \
      --show-error \
      --max-time 20 \
      --write-out '%{http_code}' \
      -H 'Cache-Control: no-cache' \
      "https://${CF_API_PUBLIC_HOSTNAME}/api/build-info" || true)
    runtime=$(tr -d '\r' <"${tmp_dir}/headers.txt" |
      sed -nE 's/^x-vm0-api-runtime:[[:space:]]*([^[:space:]]+).*/\1/ip' |
      tail -1)
    commit=$(jq -r '.commitSha // empty' "${tmp_dir}/body.json" 2>/dev/null || true)
    if [ "$status" = "200" ] && [ "$runtime" = "$expected" ] && [ "$commit" = "$EXPECTED_COMMIT" ]; then
      rm -rf "$tmp_dir"
      echo "Verified ${CF_API_PUBLIC_HOSTNAME} on ${expected} at ${EXPECTED_COMMIT}."
      return
    fi
    echo "Waiting for ${CF_API_PUBLIC_HOSTNAME} runtime=${expected} commit=${EXPECTED_COMMIT} (attempt ${attempt}/60, status=${status:-unavailable}, runtime=${runtime:-unavailable}, commit=${commit:-unavailable})"
    sleep 5
  done
  rm -rf "$tmp_dir"
  fail "${CF_API_PUBLIC_HOSTNAME} did not converge to ${expected} at ${EXPECTED_COMMIT}"
}

verify_control_plane_state() {
  local expected_proxy=$1
  local expected_route=$2
  local record route
  record=$(resolve_dns_record)
  route=$(matching_route)
  if [ "$(jq -r '.proxied' <<<"$record")" != "$expected_proxy" ]; then
    fail "DNS proxy state did not converge to ${expected_proxy}"
  fi
  if [ "$expected_route" = "present" ]; then
    if [ "$route" = "null" ] || [ "$(jq -r '.script // empty' <<<"$route")" != "$worker_name" ]; then
      fail "Worker Route ${route_pattern} did not converge to ${worker_name}"
    fi
  elif [ "$route" != "null" ]; then
    fail "Worker Route ${route_pattern} is still present"
  fi
}

if [ "$TARGET_RUNTIME" = "cloudflare" ]; then
  route=$(matching_route)
  set_dns_proxy true
  if [ "$route" = "null" ]; then
    wait_for_runtime vercel
  elif [ "$(jq -r '.script // empty' <<<"$route")" != "$worker_name" ]; then
    fail "Worker Route ${route_pattern} belongs to an unexpected script"
  fi
  ensure_worker_route
  wait_for_runtime cloudflare-worker
  verify_control_plane_state true present
else
  route=$(matching_route)
  record=$(resolve_dns_record)
  if [ "$route" = "null" ] && [ "$(jq -r '.proxied' <<<"$record")" = "false" ]; then
    wait_for_runtime vercel
    verify_control_plane_state false absent
  else
    remove_worker_route
    set_dns_proxy true
    wait_for_runtime vercel
    set_dns_proxy false
    wait_for_runtime vercel
    verify_control_plane_state false absent
  fi
fi

echo "API runtime converged to ${TARGET_RUNTIME} at ${EXPECTED_COMMIT}."
