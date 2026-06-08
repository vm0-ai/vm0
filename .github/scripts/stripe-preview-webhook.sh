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

install_stripe_cli() {
  export PATH="$HOME/.local/bin:$PATH"
  bash e2e/scripts/ensure-stripe-cli.sh >/dev/null
}

stripe_with_retry() {
  local attempt
  local delay=2
  local output
  local status

  for attempt in 1 2 3 4 5; do
    status=0
    output="$(stripe --api-key "$STRIPE_SECRET_KEY" "$@" 2>&1)" || status=$?
    if [[ "$status" -eq 0 ]]; then
      printf '%s\n' "$output"
      return 0
    fi

    if [[ "$attempt" -eq 5 ]] || ! grep -Eiq 'rate limit|too many requests| 429\b|status=429' <<<"$output"; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi

    echo "Stripe API rate limited; retrying in ${delay}s (attempt ${attempt}/5)" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
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
    if [[ -n "$starting_after" ]]; then
      response="$(stripe_with_retry webhook_endpoints list --limit 100 --starting-after "$starting_after")"
    else
      response="$(stripe_with_retry webhook_endpoints list --limit 100)"
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
      | .id
    ' <<<"$response")"
    if [[ -n "$ids" ]]; then
      printf '%s\n' "$ids"
    fi

    if [[ "$(jq -r '.has_more' <<<"$response")" != "true" ]]; then
      break
    fi

    starting_after="$(jq -r '.data[-1].id // ""' <<<"$response")"
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
    stripe_with_retry webhook_endpoints delete "$endpoint_id" --confirm >/dev/null
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
    webhook_endpoints create
    --confirm
    --description "vm0 API preview webhook for ${JOB_REF}"
    --url "$webhook_url"
    -d "metadata[managed_by]=github-actions"
    -d "metadata[job_ref]=${JOB_REF}"
    -d "metadata[github_pr]=${pr_number}"
  )
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    create_args+=(-d "metadata[github_repository]=${GITHUB_REPOSITORY}")
  fi
  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    create_args+=(-d "metadata[github_run_id]=${GITHUB_RUN_ID}")
  fi
  local event
  for event in "${EVENTS[@]}"; do
    create_args+=(--enabled-events "$event")
  done

  local endpoint
  endpoint="$(stripe_with_retry "${create_args[@]}")"

  local endpoint_id webhook_secret
  endpoint_id="$(jq -r '.id // ""' <<<"$endpoint")"
  webhook_secret="$(jq -r '.secret // ""' <<<"$endpoint")"
  echo "::add-mask::${webhook_secret}"

  if [[ "$endpoint_id" != we_* ]]; then
    echo "::error::Stripe did not return a webhook endpoint id" >&2
    exit 1
  fi
  if [[ "$webhook_secret" != whsec_* ]]; then
    echo "::error::Stripe did not return a webhook signing secret" >&2
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
  install_stripe_cli

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
