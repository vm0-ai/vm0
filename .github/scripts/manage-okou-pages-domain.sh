#!/usr/bin/env bash
set -euo pipefail

if (( $# < 5 )); then
  echo "usage: $0 <begin|finish|ensure|delete> <account-id> <zone-id> <project-name> <domain> [branch]" >&2
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
  local response

  if ! response="$(cloudflare_response --fail-with-body "$@")"; then
    printf '%s\n' "$response" >&2
    return 1
  fi

  printf '%s\n' "$response"
}

pages_domain_state() {
  cloudflare_response "${pages_domains_url}/${domain}"
}

pages_domain_missing() {
  jq -e 'any(.errors[]?; .code == 8000021)' >/dev/null
}

pages_domain_already_added() {
  jq -e 'any(.errors[]?; .code == 8000018)' >/dev/null
}

require_cloudflare_success() {
  local response

  response="$(cat)"
  if jq -e '.success == false' <<< "$response" >/dev/null; then
    jq -r '.errors[]? | "Cloudflare API error \(.code): \(.message)"' \
      <<< "$response" >&2
    return 1
  fi
}

dns_record() {
  cloudflare_request \
    "${dns_records_url}?name=${domain}" |
    jq -c '.result[0] // null'
}

delete_dns_record() {
  local record_id

  record_id="$(dns_record | jq -r '.id // empty')"
  if [[ -n "$record_id" ]]; then
    cloudflare_request \
      --request DELETE \
      "${dns_records_url}/${record_id}" >/dev/null
  fi
}

upsert_cname() {
  local target="$1"
  local record
  local record_id
  local record_type
  local body

  record="$(dns_record)"
  record_id="$(jq -r '.id // empty' <<< "$record")"
  record_type="$(jq -r '.type // empty' <<< "$record")"
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
      return
    fi

    if [[ "$record_type" == "CNAME" ]]; then
      cloudflare_request \
        --request PUT \
        "${dns_records_url}/${record_id}" \
        --data "$body" >/dev/null
      return
    fi

    cloudflare_request \
      --request DELETE \
      "${dns_records_url}/${record_id}" >/dev/null
  fi

  cloudflare_request \
    --request POST \
    "$dns_records_url" \
    --data "$body" >/dev/null
}

domain_is_active() {
  local domain_state="$1"

  [[ "$(jq -r '.result.status' <<< "$domain_state")" == "active" ||
    "$(jq -r '.result.verification_data.status' <<< "$domain_state")" == "active" ]]
}

begin_domain_validation() {
  local domain_state

  domain_state="$(pages_domain_state)"
  if pages_domain_missing <<< "$domain_state"; then
    delete_dns_record
    domain_state="$(cloudflare_response \
      --request POST \
      "$pages_domains_url" \
      --data "$(jq -n --arg name "$domain" '{name: $name}')")"
    if pages_domain_already_added <<< "$domain_state"; then
      upsert_cname "${project_name}.pages.dev"
      printf 'pending\n'
      return
    fi
    require_cloudflare_success <<< "$domain_state"
  else
    require_cloudflare_success <<< "$domain_state"
  fi

  if domain_is_active "$domain_state"; then
    upsert_cname "${branch}.${project_name}.pages.dev"
    printf 'active\n'
    return
  fi

  upsert_cname "${project_name}.pages.dev"
  printf 'pending\n'
}

finish_domain_validation() {
  local domain_state

  domain_state="$(pages_domain_state)"
  if ! pages_domain_missing <<< "$domain_state"; then
    require_cloudflare_success <<< "$domain_state"
  fi

  if ! domain_is_active "$domain_state"; then
    upsert_cname "${project_name}.pages.dev"

    # A newly-created Pages custom domain can take longer than a minute to
    # become readable and publish ownership verification even after its CNAME
    # is visible.
    for _ in {1..90}; do
      domain_state="$(pages_domain_state)"
      if pages_domain_missing <<< "$domain_state"; then
        sleep 2
        continue
      fi
      require_cloudflare_success <<< "$domain_state"
      if domain_is_active "$domain_state"; then
        break
      fi
      sleep 2
    done

    if ! domain_is_active "$domain_state"; then
      echo "Cloudflare Pages did not verify ${domain}" >&2
      exit 1
    fi
  fi

  upsert_cname "${branch}.${project_name}.pages.dev"
  echo "Cloudflare Pages custom branch domain configured: https://${domain}"
}

case "$action" in
  begin)
    : "${branch:?branch is required for begin}"
    begin_domain_validation
    ;;
  finish)
    : "${branch:?branch is required for finish}"
    finish_domain_validation
    ;;
  ensure)
    : "${branch:?branch is required for ensure}"
    validation_status="$(begin_domain_validation)"
    if [[ "$validation_status" == "active" ]]; then
      echo "Cloudflare Pages custom branch domain configured: https://${domain}"
    else
      finish_domain_validation
    fi
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

    delete_dns_record
    echo "Cloudflare Pages custom branch domain deleted: ${domain}"
    ;;
  *)
    echo "unsupported action: $action" >&2
    exit 1
    ;;
esac
