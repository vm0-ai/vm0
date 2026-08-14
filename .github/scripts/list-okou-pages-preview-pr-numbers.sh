#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 <account-id> <project-name>" >&2
  exit 1
fi

account_id="$1"
project_name="$2"

: "${account_id:?Cloudflare account ID is required}"
: "${project_name:?Cloudflare Pages project name is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

api_url="https://api.cloudflare.com/client/v4/accounts/${account_id}/pages/projects/${project_name}/deployments"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pr_numbers="$tmp_dir/pr-numbers"
touch "$pr_numbers"

page=1
total_pages=1
while (( page <= total_pages )); do
  response_file="$tmp_dir/page-${page}.json"
  curl --fail-with-body --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --retry-delay 1 \
    "${api_url}?env=preview&page=${page}&per_page=25" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --output "$response_file"

  jq -e '.success == true' "$response_file" >/dev/null
  response_total_pages="$(jq -er '.result_info.total_pages' "$response_file")"
  if [[ ! "$response_total_pages" =~ ^[0-9]+$ ]]; then
    echo "invalid Cloudflare Pages total_pages: $response_total_pages" >&2
    exit 1
  fi
  if (( response_total_pages > total_pages )); then
    total_pages="$response_total_pages"
  fi

  jq -r '
    .result[]
    | select(.environment == "preview")
    | (.deployment_trigger.metadata.branch // "")
    | select(test("^pr-[1-9][0-9]*-app$"))
    | capture("^pr-(?<number>[1-9][0-9]*)-app$").number
  ' "$response_file" >> "$pr_numbers"

  page=$((page + 1))
done

sort -n -u "$pr_numbers"
