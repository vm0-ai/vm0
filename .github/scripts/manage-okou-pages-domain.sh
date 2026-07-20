#!/usr/bin/env bash
set -euo pipefail

if (( $# < 5 )); then
  echo "usage: $0 <ensure|delete> <account-id> <zone-id> <project-name> <domain> [branch]" >&2
  exit 1
fi

action="$1"
account_id="$2"
zone_id="$3"
project_name="$4"
domain="$5"
branch="${6:-}"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

api_base="https://api.cloudflare.com/client/v4"
auth_header="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
pages_domains_url="${api_base}/accounts/${account_id}/pages/projects/${project_name}/domains"
dns_records_url="${api_base}/zones/${zone_id}/dns_records"

cloudflare_request() {
  curl --fail-with-body --silent --show-error "$@" \
    --header "$auth_header" \
    --header "Content-Type: application/json"
}

dns_record() {
  cloudflare_request \
    "${dns_records_url}?type=CNAME&name=${domain}" |
    jq -c '.result[0] // null'
}

upsert_cname() {
  local target="$1"
  local record
  local record_id
  local body

  record="$(dns_record)"
  record_id="$(jq -r '.id // empty' <<< "$record")"
  body="$(jq -n \
    --arg name "$domain" \
    --arg target "$target" \
    '{
      type: "CNAME",
      name: $name,
      content: $target,
      proxied: true,
      ttl: 1,
      comment: "Managed by vm0 PR preview lifecycle"
    }')"

  if [[ -n "$record_id" ]]; then
    if jq -e \
      --arg target "$target" \
      '.type == "CNAME" and .content == $target and .proxied == true and .ttl == 1' \
      <<< "$record" >/dev/null; then
      echo "Cloudflare DNS record already configured: ${domain} -> ${target}"
      return
    fi

    cloudflare_request \
      --request PUT \
      "${dns_records_url}/${record_id}" \
      --data "$body" >/dev/null
  else
    cloudflare_request \
      --request POST \
      "$dns_records_url" \
      --data "$body" >/dev/null
  fi
}

case "$action" in
  ensure)
    : "${branch:?branch is required for ensure}"

    domains="$(cloudflare_request "$pages_domains_url")"
    if ! jq -e --arg domain "$domain" \
      '.result[] | select(.name == $domain)' <<< "$domains" >/dev/null; then
      cloudflare_request \
        --request POST \
        "$pages_domains_url" \
        --data "$(jq -n --arg name "$domain" '{name: $name}')" >/dev/null
    fi

    domain_state="$(cloudflare_request "${pages_domains_url}/${domain}")"
    domain_status="$(jq -r '.result.status' <<< "$domain_state")"
    verification_status="$(jq -r '.result.verification_data.status' <<< "$domain_state")"

    if [[ "$domain_status" != "active" && "$verification_status" != "active" ]]; then
      upsert_cname "${project_name}.pages.dev"

      for _ in {1..30}; do
        domain_state="$(cloudflare_request "${pages_domains_url}/${domain}")"
        verification_status="$(jq -r '.result.verification_data.status' <<< "$domain_state")"
        if [[ "$verification_status" == "active" ]]; then
          break
        fi
        sleep 2
      done

      if [[ "$verification_status" != "active" ]]; then
        echo "Cloudflare Pages did not verify ${domain}" >&2
        exit 1
      fi
    fi

    upsert_cname "${branch}.${project_name}.pages.dev"
    echo "Cloudflare Pages custom branch domain configured: https://${domain}"
    ;;
  delete)
    domains="$(cloudflare_request "$pages_domains_url")"
    if jq -e --arg domain "$domain" \
      '.result[] | select(.name == $domain)' <<< "$domains" >/dev/null; then
      cloudflare_request \
        --request DELETE \
        "${pages_domains_url}/${domain}" >/dev/null
    fi

    record_id="$(dns_record | jq -r '.id // empty')"
    if [[ -n "$record_id" ]]; then
      cloudflare_request \
        --request DELETE \
        "${dns_records_url}/${record_id}" >/dev/null
    fi
    echo "Cloudflare Pages custom branch domain deleted: ${domain}"
    ;;
  *)
    echo "unsupported action: $action" >&2
    exit 1
    ;;
esac
