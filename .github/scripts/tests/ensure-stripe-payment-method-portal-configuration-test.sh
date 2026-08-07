#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/ensure-stripe-payment-method-portal-configuration.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

fake_bin="${test_dir}/bin"
mkdir -p "$fake_bin"
cat > "${fake_bin}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$STRIPE_CURL_LOG"

configuration() {
  printf '%s\n' '{
    "id": "'"$1"'",
    "active": true,
    "features": {
      "customer_update": {"enabled": false},
      "invoice_history": {"enabled": false},
      "payment_method_update": {"enabled": true},
      "subscription_cancel": {"enabled": false},
      "subscription_pause": {"enabled": false},
      "subscription_update": {"enabled": false}
    },
    "login_page": {"enabled": false},
    "metadata": {
      "managed_by": "vm0",
      "purpose": "payment_method_management"
    }
  }'
}

if [[ "$*" == *"?active=true&limit=100"* ]]; then
  if [[ "$STRIPE_FIXTURE_MODE" == "existing" ]]; then
    printf '{"data":['
    configuration "bpc_existing"
    printf ']}\n'
  else
    printf '{"data":[]}\n'
  fi
  exit 0
fi

configuration "bpc_created"
EOF
chmod +x "${fake_bin}/curl"

run_case() {
  local mode="$1"
  local expected_id="$2"
  local expected_calls="$3"
  local env_file="${test_dir}/${mode}.env"
  local curl_log="${test_dir}/${mode}.curl.log"

  printf 'EXISTING_VALUE=kept\n' > "$env_file"
  PATH="${fake_bin}:${PATH}" \
    STRIPE_SECRET_KEY="sk_test_fixture" \
    STRIPE_API_ORIGIN="https://stripe.test" \
    STRIPE_FIXTURE_MODE="$mode" \
    STRIPE_CURL_LOG="$curl_log" \
    bash "$script" "$env_file"

  grep -qx "EXISTING_VALUE=kept" "$env_file"
  grep -qx "STRIPE_PAYMENT_METHOD_PORTAL_CONFIGURATION_ID=${expected_id}" "$env_file"
  [[ "$(wc -l < "$curl_log" | tr -d ' ')" == "$expected_calls" ]]
}

run_case existing bpc_existing 1
run_case missing bpc_created 2

echo "ensure-stripe-payment-method-portal-configuration-test: ok"
