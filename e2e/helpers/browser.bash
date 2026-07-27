#!/usr/bin/env bash
# browser.bash — Reusable bats helpers for agent-browser E2E tests
#
# Provides helper functions for browser automation via agent-browser.
# Load from bats tests with: load '../../helpers/browser'
#
# Required env vars:
#   VM0_API_BACKEND_URL  — Target API backend URL (e.g., https://api.vm7.ai:8443)
#
# Optional env vars:
#   E2E_ACCOUNT  — Test email address (auto-generated if empty)

# ---------------------------------------------------------------------------
# url_is_on_app — Check if a URL's hostname matches the expected app hostname
# Usage: url_is_on_app <url> [check_url]
#   check_url — URL to compare against (default: APP_URL from calling context)
# Compares hostnames rather than assuming "app." prefix, so it works for all
# environments (app.vm7.ai, staging-app.omby.ai, etc.).
# ---------------------------------------------------------------------------
url_is_on_app() {
  local url="$1"
  local check_url="${2:-$APP_URL}"
  local url_host check_host
  url_host=$(echo "$url" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  check_host=$(echo "$check_url" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  [[ "$url_host" == "$check_host" ]]
}

# ---------------------------------------------------------------------------
# browser_setup — Validate environment, initialize shared state
# Call this in setup_file() before any browser interactions.
# ---------------------------------------------------------------------------
browser_setup() {
  if [[ -z "${VM0_API_BACKEND_URL:-}" ]]; then
    echo "VM0_API_BACKEND_URL is required but not set" >&2
    return 1
  fi

  if ! command -v agent-browser &>/dev/null; then
    echo "agent-browser is not installed. Install with: npm install -g agent-browser" >&2
    return 1
  fi

  export NODE_TLS_REJECT_UNAUTHORIZED=0
  export AGENT_BROWSER_DEFAULT_TIMEOUT=30000
  export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-${JOB_REF:-local}-sign-up}"

  export OTP="424242"

  if [[ -z "${E2E_ACCOUNT:-}" ]]; then
    E2E_ACCOUNT="$(generate_test_email)"
    export E2E_ACCOUNT
  fi

  AGENT_BROWSER_IGNORE_HTTPS_ERRORS=true agent-browser set viewport 1920 1080
}

# ---------------------------------------------------------------------------
# generate_test_email — Generate a random test email with +clerk_test suffix
# Format: ${JOB_REF}+clerk_test@${8_RANDOM_HEX}.ai
# ---------------------------------------------------------------------------
generate_test_email() {
  local job_ref="${JOB_REF:-local}"
  local rand_hex
  rand_hex=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 8)
  echo "${job_ref}+clerk_test@${rand_hex}.ai"
}

# ---------------------------------------------------------------------------
# wait_for_browser_target — Wait for a browser target across navigation
# agent-browser may surface a transient CDP context error when Clerk replaces
# the document while a selector wait is active. Retry that transition without
# adding a fixed delay; preserve real selector timeouts as failures.
# Usage: wait_for_browser_target [timeout-ms] <agent-browser wait arguments...>
# ---------------------------------------------------------------------------
wait_for_browser_target() {
  local timeout_ms=30000
  if [[ "$1" =~ ^[0-9]+$ ]]; then
    timeout_ms="$1"
    shift
  fi

  local navigation_attempt wait_output

  for navigation_attempt in 1 2 3; do
    if wait_output=$(AGENT_BROWSER_DEFAULT_TIMEOUT="$timeout_ms" agent-browser wait "$@" 2>&1); then
      return 0
    fi
    if [[ "$wait_output" != *"Inspected target navigated or closed"* ]]; then
      echo "$wait_output" >&2
      return 1
    fi
  done

  echo "$wait_output" >&2
  return 1
}

# ---------------------------------------------------------------------------
# wait_for_auth_next_step — Wait for Clerk to redirect or render its next form
# Emits one of: complete, otp, password.
# ---------------------------------------------------------------------------
wait_for_auth_next_step() {
  local auth_path="$1"
  local timeout_ms="${2:-45000}"
  local otp_selector='input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]'

  wait_for_browser_target "$timeout_ms" --fn \
    "(() => {
      if (!window.location.pathname.includes('/${auth_path}')) return true;
      if (document.querySelector('${otp_selector}')) return true;
      if ('${auth_path}' !== 'sign-in') return false;
      const text = document.body.innerText.toLowerCase();
      return Boolean(document.querySelector('input[type=\"password\"]'))
        || text.includes('use another method')
        || text.includes('forgot password');
    })()"

  if [[ "$(agent-browser eval "window.location.pathname.includes('/${auth_path}')")" != "true" ]]; then
    echo "complete"
  elif [[ "$(agent-browser get count "$otp_selector")" -gt 0 ]]; then
    echo "otp"
  else
    echo "password"
  fi
}

# ---------------------------------------------------------------------------
# accept_legal_consent — Check legal consent checkbox if present
# Clerk renders this when legal_consent_enabled is on. Safe to call always.
# ---------------------------------------------------------------------------
accept_legal_consent() {
  if [[ "$(agent-browser get count 'input[name="legalAccepted"]')" -gt 0 ]]; then
    agent-browser check 'input[name="legalAccepted"]'
  fi
}

# ---------------------------------------------------------------------------
# click_continue — Click form "Continue" button (not "Continue with Google")
# ---------------------------------------------------------------------------
click_continue() {
  agent-browser find role button click --name "Continue" --exact
}

# ---------------------------------------------------------------------------
# dismiss_cookie_banner — Dismiss cookie consent banner if present
# ---------------------------------------------------------------------------
dismiss_cookie_banner() {
  if [[ "$(agent-browser eval \
    "Array.from(document.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === 'Accept'
    )")" == "true" ]]; then
    agent-browser find role button click --name "Accept" --exact
  fi
}

# ---------------------------------------------------------------------------
# enter_otp — Enter OTP verification code
# ---------------------------------------------------------------------------
enter_otp() {
  local code="$1"
  local auth_path="$2"
  local otp_selector='input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]'

  wait_for_browser_target "$otp_selector"
  if [[ "$(agent-browser get count "$otp_selector")" -eq 1 ]]; then
    agent-browser fill "$otp_selector" "$code"
  else
    agent-browser find first "$otp_selector" click
    local digit
    for digit in $(echo "$code" | grep -o .); do
      agent-browser press "$digit"
    done
  fi

  wait_for_browser_target --fn \
    "(() => {
      if (!window.location.pathname.includes('/${auth_path}')) return true;
      return Array.from(document.querySelectorAll('button')).some((button) => {
        const label = button.textContent?.trim() ?? '';
        return !button.disabled && /^(Continue|Verify)$/i.test(label);
      });
    })()"

  if [[ "$(agent-browser eval "window.location.pathname.includes('/${auth_path}')")" == "true" ]]; then
    if ! agent-browser find role button click --name "Continue" --exact 2>/dev/null; then
      agent-browser find role button click --name "Verify" --exact
    fi
  fi
}

# ---------------------------------------------------------------------------
# generate_password — Generate random 20-char password for sign-up
# ---------------------------------------------------------------------------
generate_password() {
  local rand
  rand=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
  echo "${rand:0:16}!Aa1"
}

# ---------------------------------------------------------------------------
# create_clerk_sign_in_token — Create a Clerk sign-in token for e2e test user
# Requires CLERK_SECRET_KEY. Exports SIGN_IN_TOKEN on success.
# ---------------------------------------------------------------------------
create_clerk_sign_in_token() {
  if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
    echo "CLERK_SECRET_KEY is required but not set" >&2
    return 1
  fi

  local email="${E2E_ACCOUNT}"

  local clerk_api_url="https://api.clerk.com"

  # Resolve user ID from email
  local users_response
  users_response=$(curl -sS -X GET \
    "${clerk_api_url}/v1/users?email_address[]=${email}" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json")

  local user_id
  user_id=$(echo "$users_response" | jq -e -r '.[0].id' 2>/dev/null)
  if [[ -z "$user_id" || "$user_id" == "null" ]]; then
    echo "Failed to resolve user ID for ${email}" >&2
    echo "API response: ${users_response}" >&2
    return 1
  fi

  # Create sign-in token
  local token_response
  token_response=$(curl -sS -X POST \
    "${clerk_api_url}/v1/sign_in_tokens" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\": \"${user_id}\", \"expires_in_seconds\": 300}")

  local token
  token=$(echo "$token_response" | jq -e -r '.token' 2>/dev/null)
  if [[ -z "$token" || "$token" == "null" ]]; then
    echo "Failed to create sign-in token" >&2
    echo "API response: ${token_response}" >&2
    return 1
  fi

  export SIGN_IN_TOKEN="$token"
}

# ---------------------------------------------------------------------------
# delete_e2e_account_if_exists — Delete the E2E_ACCOUNT from Clerk if it exists
# Call this before sign-up to ensure a clean test state.
# Requires CLERK_SECRET_KEY and E2E_ACCOUNT to be set.
# ---------------------------------------------------------------------------
delete_e2e_account_if_exists() {
  if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
    echo "CLERK_SECRET_KEY is required but not set" >&2
    return 1
  fi

  local clerk_api_url="https://api.clerk.com"

  local users_response
  users_response=$(curl -sS -X GET \
    "${clerk_api_url}/v1/users?email_address[]=${E2E_ACCOUNT}" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json")

  local user_id
  user_id=$(echo "$users_response" | jq -r '.[0].id // empty' 2>/dev/null)
  if [[ -z "$user_id" ]]; then
    echo "# E2E account does not exist, nothing to delete" >&3
    return 0
  fi

  echo "# Deleting existing E2E account: ${E2E_ACCOUNT} (${user_id})" >&3
  curl -sS -X DELETE \
    "${clerk_api_url}/v1/users/${user_id}" \
    -H "Authorization: Bearer ${CLERK_SECRET_KEY}" \
    -H "Content-Type: application/json" > /dev/null
}

# ---------------------------------------------------------------------------
# derive_app_url — Derive platform app URL from VM0_API_BACKEND_URL
# Local:  https://api.vm7.ai:8443  → https://app.vm7.ai:8443
# CI:     https://pr-123-api.vm0-dev.com → https://pr-123-app.vm0-dev.com
# ---------------------------------------------------------------------------
derive_app_url() {
  if [[ -n "${APP_URL:-}" ]]; then
    printf '%s' "$APP_URL"
    return
  fi

  local source="${VM0_API_BACKEND_URL}"
  source="${source/\/\/api./\/\/app.}"
  source="${source/-api./-app.}"
  source="${source/\/\/www./\/\/app.}"
  source="${source/-www./-app.}"
  printf '%s' "$source"
}

# ---------------------------------------------------------------------------
# sign_in_via_token — Sign in via Clerk token and wait for redirect
# Requires SIGN_IN_TOKEN to be set (call create_clerk_sign_in_token first).
# Usage: sign_in_via_token [base_url]
#   base_url — URL to sign in on (default: APP_URL, fallback: derived app URL)
# ---------------------------------------------------------------------------
sign_in_via_token() {
  local base_url="${1:-$(derive_app_url)}"
  agent-browser open "${base_url}/sign-in-token?token=${SIGN_IN_TOKEN}"

  wait_for_browser_target --fn \
    "!window.location.pathname.includes('/sign-in-token')"

  local current_url
  current_url=$(agent-browser get url 2>/dev/null || true)
  if ! url_is_on_app "$current_url" "$base_url"; then
    echo "Failed to redirect after sign-in-token" >&2
    return 1
  fi

  # Dismiss cookie banner if present
  dismiss_cookie_banner
}

# ---------------------------------------------------------------------------
# sign_in_via_token_on_app — Sign in via Clerk token on the platform app domain
# Opens /sign-in-token, waits for auth redirect, dismisses cookie banner.
# Requires APP_URL and SIGN_IN_TOKEN to be set.
# ---------------------------------------------------------------------------
sign_in_via_token_on_app() {
  echo "# Signing in via token on platform app..." >&3
  sign_in_via_token "$APP_URL"
  echo "# Authentication complete!" >&3
}

# ---------------------------------------------------------------------------
# navigate_to_app_page — Navigate to a path on the platform app domain
# Usage: navigate_to_app_page "/team"
# ---------------------------------------------------------------------------
navigate_to_app_page() {
  local path="$1"
  local app_url
  app_url="$(derive_app_url)"
  agent-browser open "${app_url}${path}"
}

# ---------------------------------------------------------------------------
# wait_for_text — Wait for text to appear on page (case-insensitive)
# Usage: wait_for_text "some text" [timeout_secs]
# ---------------------------------------------------------------------------
wait_for_text() {
  local text="$1"
  local timeout_secs="${2:-15}"
  wait_for_browser_target "$((timeout_secs * 1000))" --text "$text"
}

# ---------------------------------------------------------------------------
# wait_for_text_gone — Wait for text to disappear from page (case-insensitive)
# Usage: wait_for_text_gone "some text" [timeout_secs]
# ---------------------------------------------------------------------------
wait_for_text_gone() {
  local text="$1"
  local timeout_secs="${2:-15}"
  local text_json
  text_json=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$text")
  wait_for_browser_target "$((timeout_secs * 1000))" --fn \
    "!document.body.innerText.toLowerCase().includes(${text_json}.toLowerCase())"
}

# ---------------------------------------------------------------------------
# browser_teardown — Kill agent-browser and any spawned browser processes
# Call this in teardown_file() to prevent bats from hanging.
# ---------------------------------------------------------------------------
browser_teardown() {
  # Close browser gracefully first
  agent-browser close 2>/dev/null || true

  # Kill any remaining agent-browser or chromium processes
  pkill -f 'agent-browser' 2>/dev/null || true
  pkill -f '[c]hrom(e|ium)' 2>/dev/null || true
}
