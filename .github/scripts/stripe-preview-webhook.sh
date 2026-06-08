#!/usr/bin/env bash
set -euo pipefail

EVENTS=(
  checkout.session.completed
  checkout.session.async_payment_succeeded
  invoice.paid
  customer.subscription.created
  customer.subscription.updated
  customer.subscription.deleted
  subscription_schedule.released
  subscription_schedule.canceled
  subscription_schedule.aborted
)

usage() {
  cat >&2 <<'USAGE'
Usage:
  .github/scripts/stripe-preview-webhook.sh upsert
  .github/scripts/stripe-preview-webhook.sh cleanup

Required environment:
  STRIPE_SECRET_KEY
  JOB_REF

Additional environment for upsert:
  API_ENV_FILE

Optional environment:
  API_PREVIEW_URL
USAGE
}

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "::error::${key} is required" >&2
    exit 1
  fi
}

STRIPE_API_BASE_URL="${STRIPE_API_BASE_URL:-https://api.stripe.com/v1}"

print_stripe_error() {
  local response="$1"
  local fallback="$2"
  local error_message

  error_message="$(jq -r '
    if .error then
      [
        (.error.type // "unknown_error"),
        (.error.code // empty),
        (.error.message // "no message")
      ]
      | map(select(. != ""))
      | join(": ")
    else
      empty
    end
  ' <<<"$response" 2>/dev/null || true)"
  if [[ -n "$error_message" ]]; then
    echo "::error::${fallback}: ${error_message}" >&2
    return
  fi

  local object keys
  object="$(jq -r '.object // empty' <<<"$response" 2>/dev/null || true)"
  keys="$(jq -r 'if type == "object" then keys_unsorted | join(",") else empty end' <<<"$response" 2>/dev/null || true)"
  if [[ -n "$object" || -n "$keys" ]]; then
    echo "::error::${fallback}; response object=${object:-unknown}, keys=${keys:-unknown}" >&2
  elif [[ -n "$response" ]]; then
    echo "::error::${fallback}; Stripe returned a non-JSON response" >&2
  else
    echo "::error::${fallback}; Stripe returned an empty response" >&2
  fi
}

json_field() {
  local response="$1"
  local filter="$2"
  jq -r "${filter} // \"\"" <<<"$response" 2>/dev/null || true
}

stripe_api_request() {
  local method="$1"
  local path="$2"
  shift 2

  local response_file
  response_file="$(mktemp)"
  local http_status=""
  local status=0

  http_status="$(
    curl \
      --silent \
      --show-error \
      --request "$method" \
      --user "${STRIPE_SECRET_KEY}:" \
      --retry 5 \
      --retry-delay 2 \
      --retry-max-time 60 \
      --retry-all-errors \
      --connect-timeout 10 \
      --max-time 30 \
      --output "$response_file" \
      --write-out '%{http_code}' \
      "$@" \
      "${STRIPE_API_BASE_URL}${path}"
  )" || status=$?

  local response
  response="$(cat "$response_file")"
  rm -f "$response_file"

  if [[ "$status" -ne 0 ]]; then
    print_stripe_error "$response" "Stripe API ${method} ${path} failed"
    return "$status"
  fi

  if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    print_stripe_error "$response" "Stripe API ${method} ${path} failed with HTTP ${http_status:-unknown}"
    return 1
  fi

  printf '%s\n' "$response"
}

preview_pr_number() {
  sed -nE 's/^pr-([0-9]+)$/\1/p' <<<"$JOB_REF"
}

list_matching_endpoint_ids() {
  local webhook_url="${1:-}"
  local starting_after=""
  local response
  local ids

  while true; do
    local list_args=(
      --get
      --data-urlencode "limit=100"
    )
    if [[ -n "$starting_after" ]]; then
      list_args+=(--data-urlencode "starting_after=${starting_after}")
    fi

    response="$(stripe_api_request GET "/webhook_endpoints" "${list_args[@]}")"
    if ! jq -e '.data | type == "array"' >/dev/null 2>&1 <<<"$response"; then
      print_stripe_error "$response" "Stripe did not return a webhook endpoint list"
      exit 1
    fi

    ids="$(jq -r --arg job_ref "$JOB_REF" --arg url "$webhook_url" '
      .data[]
      | select(
          (.metadata.managed_by // "") == "github-actions"
          and (
            (.metadata.job_ref // "") == $job_ref
            or ($url != "" and .url == $url)
          )
        )
      | .id // empty
    ' <<<"$response")"
    if [[ -n "$ids" ]]; then
      printf '%s\n' "$ids"
    fi

    if [[ "$(json_field "$response" '.has_more')" != "true" ]]; then
      break
    fi

    starting_after="$(json_field "$response" '.data[-1].id')"
    if [[ -z "$starting_after" ]]; then
      break
    fi
  done
}

delete_matching_endpoints() {
  local webhook_url="${1:-}"
  local endpoint_id
  local endpoint_ids

  endpoint_ids="$(list_matching_endpoint_ids "$webhook_url")"

  while IFS= read -r endpoint_id; do
    if [[ -z "$endpoint_id" ]]; then
      continue
    fi
    echo "Deleting Stripe webhook endpoint ${endpoint_id} for ${JOB_REF}"
    stripe_api_request DELETE "/webhook_endpoints/${endpoint_id}" >/dev/null
  done <<<"$endpoint_ids"
}

write_env_secret() {
  local webhook_secret="$1"

  if grep -q '^STRIPE_WEBHOOK_SECRET=' "$API_ENV_FILE"; then
    sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=${webhook_secret}|" "$API_ENV_FILE"
  else
    printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$webhook_secret" >> "$API_ENV_FILE"
  fi
}

upsert_endpoint() {
  require_env API_ENV_FILE

  local pr_number
  pr_number="$(preview_pr_number)"
  if [[ -z "$pr_number" ]]; then
    echo "Skipping Stripe preview webhook setup for non-PR job ref: ${JOB_REF}"
    return 0
  fi
  if [[ -z "${API_PREVIEW_URL:-}" ]]; then
    echo "Skipping Stripe preview webhook setup because API_PREVIEW_URL is empty"
    return 0
  fi

  local webhook_url="${API_PREVIEW_URL%/}/api/webhooks/stripe"
  delete_matching_endpoints "$webhook_url"

  local create_args=(
    --header "Idempotency-Key: vm0-preview-webhook-${JOB_REF}-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
    --data-urlencode "description=vm0 API preview webhook for ${JOB_REF}"
    --data-urlencode "url=${webhook_url}"
    --data-urlencode "metadata[managed_by]=github-actions"
    --data-urlencode "metadata[job_ref]=${JOB_REF}"
    --data-urlencode "metadata[github_pr]=${pr_number}"
  )
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    create_args+=(--data-urlencode "metadata[github_repository]=${GITHUB_REPOSITORY}")
  fi
  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    create_args+=(--data-urlencode "metadata[github_run_id]=${GITHUB_RUN_ID}")
  fi
  local event
  for event in "${EVENTS[@]}"; do
    create_args+=(--data-urlencode "enabled_events[]=${event}")
  done

  local endpoint
  endpoint="$(stripe_api_request POST "/webhook_endpoints" "${create_args[@]}")"

  local endpoint_id webhook_secret
  endpoint_id="$(json_field "$endpoint" '.id')"
  webhook_secret="$(json_field "$endpoint" '.secret')"
  if [[ -n "$webhook_secret" ]]; then
    echo "::add-mask::${webhook_secret}"
  fi

  if [[ "$endpoint_id" != we_* ]]; then
    print_stripe_error "$endpoint" "Stripe did not return a webhook endpoint id"
    exit 1
  fi
  if [[ "$webhook_secret" != whsec_* ]]; then
    print_stripe_error "$endpoint" "Stripe did not return a webhook signing secret"
    exit 1
  fi

  write_env_secret "$webhook_secret"
  echo "Configured Stripe webhook endpoint ${endpoint_id} for ${webhook_url}"
}

cleanup_endpoint() {
  local pr_number
  pr_number="$(preview_pr_number)"
  if [[ -z "$pr_number" ]]; then
    echo "Skipping Stripe preview webhook cleanup for non-PR job ref: ${JOB_REF}"
    return 0
  fi

  local webhook_url="${API_PREVIEW_URL:-}"
  if [[ -n "$webhook_url" ]]; then
    webhook_url="${webhook_url%/}/api/webhooks/stripe"
  fi
  delete_matching_endpoints "$webhook_url"
  echo "Cleaned up Stripe webhook endpoints for ${JOB_REF}"
}

main() {
  if [[ "$#" -ne 1 ]]; then
    usage
    exit 1
  fi

  require_env STRIPE_SECRET_KEY
  require_env JOB_REF

  case "$1" in
    upsert)
      upsert_endpoint
      ;;
    cleanup)
      cleanup_endpoint
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
