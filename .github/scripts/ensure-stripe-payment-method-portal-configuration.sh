#!/usr/bin/env bash

set -euo pipefail

env_file="${1:-}"
if [[ -z "$env_file" || ! -f "$env_file" ]]; then
  echo "API environment file is required" >&2
  exit 1
fi
if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "STRIPE_SECRET_KEY is required" >&2
  exit 1
fi

stripe_api="${STRIPE_API_ORIGIN:-https://api.stripe.com}"
configuration_name="VM0 payment methods"
configuration_args=(
  --data-urlencode "name=${configuration_name}"
  --data-urlencode "features[customer_update][enabled]=false"
  --data-urlencode "features[invoice_history][enabled]=false"
  --data-urlencode "features[payment_method_update][enabled]=true"
  --data-urlencode "features[subscription_cancel][enabled]=false"
  --data-urlencode "features[subscription_pause][enabled]=false"
  --data-urlencode "features[subscription_update][enabled]=false"
  --data-urlencode "login_page[enabled]=false"
  --data-urlencode "metadata[managed_by]=vm0"
  --data-urlencode "metadata[purpose]=payment_method_management"
)

stripe_error() {
  jq -r '
    if (.error | type) == "object" then
      .error.message
    else
      .error // "Unknown Stripe error"
    end
  ' <<< "$1"
}

configuration_is_restricted() {
  jq -e '
    .active == true and
    .features.customer_update.enabled == false and
    .features.invoice_history.enabled == false and
    .features.payment_method_update.enabled == true and
    .features.subscription_cancel.enabled == false and
    .features.subscription_pause.enabled == false and
    .features.subscription_update.enabled == false and
    .login_page.enabled == false and
    .metadata.managed_by == "vm0" and
    .metadata.purpose == "payment_method_management"
  ' >/dev/null <<< "$1"
}

list_response="$(
  curl --silent --show-error \
    --user "${STRIPE_SECRET_KEY}:" \
    "${stripe_api}/v1/billing_portal/configurations?active=true&limit=100"
)"
if [[ "$(jq -r '.error // empty' <<< "$list_response")" != "" ]]; then
  echo "Could not list Stripe portal configurations: $(stripe_error "$list_response")" >&2
  exit 1
fi

configuration="$(
  jq -c '
    [
      .data[]
      | select(
          .metadata.managed_by == "vm0" and
          .metadata.purpose == "payment_method_management"
        )
    ][0] // empty
  ' <<< "$list_response"
)"
configuration_id=""
if [[ -n "$configuration" ]]; then
  configuration_id="$(jq -r '.id // empty' <<< "$configuration")"
fi

if [[ -z "$configuration_id" ]]; then
  configuration="$(
    curl --silent --show-error \
      --user "${STRIPE_SECRET_KEY}:" \
      --request POST \
      --header "Idempotency-Key: vm0-payment-method-portal-v1" \
      "${configuration_args[@]}" \
      "${stripe_api}/v1/billing_portal/configurations"
  )"
  configuration_id="$(jq -r '.id // empty' <<< "$configuration")"
  if [[ -z "$configuration_id" ]]; then
    echo "Could not create Stripe portal configuration: $(stripe_error "$configuration")" >&2
    exit 1
  fi
elif ! configuration_is_restricted "$configuration"; then
  configuration="$(
    curl --silent --show-error \
      --user "${STRIPE_SECRET_KEY}:" \
      --request POST \
      "${configuration_args[@]}" \
      "${stripe_api}/v1/billing_portal/configurations/${configuration_id}"
  )"
  if [[ "$(jq -r '.id // empty' <<< "$configuration")" != "$configuration_id" ]]; then
    echo "Could not restrict Stripe portal configuration: $(stripe_error "$configuration")" >&2
    exit 1
  fi
fi

if ! configuration_is_restricted "$configuration"; then
  echo "Stripe portal configuration does not match the payment-method-only policy" >&2
  exit 1
fi

env_key="STRIPE_PAYMENT_METHOD_PORTAL_CONFIGURATION_ID"
if grep -q "^${env_key}=" "$env_file"; then
  sed -i "s|^${env_key}=.*|${env_key}=${configuration_id}|" "$env_file"
else
  printf '%s=%s\n' "$env_key" "$configuration_id" >> "$env_file"
fi

echo "Stripe payment method portal configuration: ${configuration_id}"
