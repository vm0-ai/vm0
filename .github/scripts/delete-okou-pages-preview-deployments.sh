#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  echo "usage: $0 <account-id> <project-name> <pages-branch>" >&2
  exit 1
fi

account_id="$1"
project_name="$2"
pages_branch="$3"

: "${account_id:?Cloudflare account ID is required}"
: "${project_name:?Cloudflare Pages project name is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

if [[ ! "$pages_branch" =~ ^pr-[1-9][0-9]*-app$ ]]; then
  echo "invalid app preview Pages branch: $pages_branch" >&2
  exit 1
fi

api_url="https://api.cloudflare.com/client/v4/accounts/${account_id}/pages/projects/${project_name}/deployments"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

deployment_ids="$tmp_dir/deployment-ids"
touch "$deployment_ids"

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
  if (( response_total_pages > total_pages )); then
    total_pages="$response_total_pages"
  fi

  jq -r --arg branch "$pages_branch" '
    .result[]
    | select(
        .environment == "preview"
        and .deployment_trigger.metadata.branch == $branch
      )
    | .id
  ' "$response_file" >> "$deployment_ids"

  page=$((page + 1))
done

sort -u "$deployment_ids" -o "$deployment_ids"
deployment_count="$(wc -l < "$deployment_ids")"
printf 'Found %s Cloudflare Pages deployment(s) for %s\n' \
  "$deployment_count" "$pages_branch"

while IFS= read -r deployment_id; do
  [[ -n "$deployment_id" ]] || continue
  if [[ ! "$deployment_id" =~ ^[0-9a-f-]+$ ]]; then
    echo "invalid Cloudflare Pages deployment ID: $deployment_id" >&2
    exit 1
  fi

  delete_response="$tmp_dir/delete-${deployment_id}.json"
  curl --fail-with-body --silent --show-error \
    --retry 3 \
    --retry-all-errors \
    --retry-delay 1 \
    --request DELETE \
    "${api_url}/${deployment_id}?force=true" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --output "$delete_response"
  jq -e '.success == true' "$delete_response" >/dev/null
done < "$deployment_ids"

printf 'Deleted %s Cloudflare Pages deployment(s) for %s\n' \
  "$deployment_count" "$pages_branch"
