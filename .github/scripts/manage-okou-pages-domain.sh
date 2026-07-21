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

cloudflare_response() {
  curl --silent --show-error "$@" \
    --header "$auth_header" \
    --header "Content-Type: application/json"
}

cloudflare_request() {
  cloudflare_response --fail-with-body "$@"
}

pages_domain_state() {
  cloudflare_response "${pages_domains_url}/${domain}"
}

pages_domain_missing() {
  jq -e 'any(.errors[]?; .code == 8000021)' >/dev/null
}

require_cloudflare_success() {
  if jq -e '.success == false' >/dev/null; then
    jq -r '.errors[]? | "Cloudflare API error \(.code): \(.message)"' >&2
    return 1
  fi
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

    domain_state="$(pages_domain_state)"
    if pages_domain_missing <<< "$domain_state"; then
      cloudflare_request \
        --request POST \
        "$pages_domains_url" \
        --data "$(jq -n --arg name "$domain" '{name: $name}')" >/dev/null
      domain_state="$(cloudflare_request "${pages_domains_url}/${domain}")"
    else
      require_cloudflare_success <<< "$domain_state"
    fi

    domain_status="$(jq -r '.result.status' <<< "$domain_state")"
    verification_status="$(jq -r '.result.verification_data.status' <<< "$domain_state")"

    if [[ "$domain_status" != "active" && "$verification_status" != "active" ]]; then
      upsert_cname "${project_name}.pages.dev"

      # A newly-created Pages custom domain can take longer than a minute to
      # publish ownership verification even after its CNAME is visible.
      for _ in {1..90}; do
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
    domain_state="$(pages_domain_state)"
    if pages_domain_missing <<< "$domain_state"; then
      :
    else
      require_cloudflare_success <<< "$domain_state"
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
