#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <account-id> <worker-name>" >&2
  exit 1
fi

account_id="$1"
worker_name="$2"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

worker_url="https://api.cloudflare.com/client/v4/accounts/${account_id}/workers/scripts/${worker_name}"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

http_status="$(curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --request DELETE \
  "$worker_url" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json")"

if [[ "$http_status" == "404" ]]; then
  echo "Cloudflare Worker already absent: ${worker_name}"
  exit 0
fi

if [[ "$http_status" != 2* ]] || ! jq -e '.success == true' "$response_file" >/dev/null; then
  jq -r '.errors[]? | "Cloudflare API error \(.code): \(.message)"' \
    "$response_file" >&2
  exit 1
fi

echo "Cloudflare Worker deleted: ${worker_name}"
