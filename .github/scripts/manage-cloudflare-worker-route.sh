#!/usr/bin/env bash
set -euo pipefail

if (( $# != 4 )); then
  echo "usage: $0 <ensure|delete> <zone-id> <route-pattern> <worker-name>" >&2
  exit 1
fi

action="$1"
zone_id="$2"
route_pattern="$3"
worker_name="$4"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

routes_url="https://api.cloudflare.com/client/v4/zones/${zone_id}/workers/routes"

request() {
  curl --fail-with-body --silent --show-error "$@" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json"
}

routes="$(request "$routes_url")"
route="$(jq -c --arg pattern "$route_pattern" \
  '.result[] | select(.pattern == $pattern)' <<< "$routes" | head -1)"
route_id="$(jq -r '.id // empty' <<< "$route")"

case "$action" in
  ensure)
    if [[ -n "$route_id" ]] && \
      [[ "$(jq -r '.script // empty' <<< "$route")" == "$worker_name" ]]; then
      echo "Cloudflare Worker Route already configured: ${route_pattern} -> ${worker_name}"
      exit 0
    fi

    body="$(jq -n \
      --arg pattern "$route_pattern" \
      --arg script "$worker_name" \
      '{pattern: $pattern, script: $script}')"
    if [[ -n "$route_id" ]]; then
      request --request PUT "${routes_url}/${route_id}" --data "$body" >/dev/null
    else
      request --request POST "$routes_url" --data "$body" >/dev/null
    fi
    echo "Cloudflare Worker Route configured: ${route_pattern} -> ${worker_name}"
    ;;
  delete)
    if [[ -n "$route_id" ]]; then
      request --request DELETE "${routes_url}/${route_id}" >/dev/null
    fi
    echo "Cloudflare Worker Route deleted: ${route_pattern}"
    ;;
  *)
    echo "unsupported action: $action" >&2
    exit 1
    ;;
esac
