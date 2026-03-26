#!/usr/bin/env bash
# browser.bash — Reusable bats helpers for agent-browser E2E tests
#
# Provides helper functions for browser automation via agent-browser.
# Load from bats tests with: load '../../helpers/browser'
#
# Required env vars:
#   VM0_API_URL  — Target site URL (e.g., https://www.vm7.ai:8443)
#
# Optional env vars:
#   E2E_ACCOUNT  — Test email address (auto-generated if empty)

# ---------------------------------------------------------------------------
# browser_setup — Validate environment, initialize shared state
# Call this in setup_file() before any browser interactions.
# ---------------------------------------------------------------------------
browser_setup() {
  if [[ -z "${VM0_API_URL:-}" ]]; then
    echo "VM0_API_URL is required but not set" >&2
    return 1
  fi

  if ! command -v agent-browser &>/dev/null; then
    echo "agent-browser is not installed. Install with: npm install -g agent-browser" >&2
    return 1
  fi

  export NODE_TLS_REJECT_UNAUTHORIZED=0
  export SCREENSHOT_DIR="/tmp/e2e-auth-screenshots"
  mkdir -p "$SCREENSHOT_DIR"

  export OTP="424242"
  export STEP_NUM=0

  if [[ -z "${E2E_ACCOUNT:-}" ]]; then
    E2E_ACCOUNT="$(generate_test_email)"
    export E2E_ACCOUNT
  fi
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
# step_screenshot — Take a numbered screenshot + snapshot for debugging
# ---------------------------------------------------------------------------
step_screenshot() {
  STEP_NUM=$((STEP_NUM + 1))
  export STEP_NUM
  local label="$1"
  local filename
  filename=$(printf "%02d-%s" "$STEP_NUM" "$label")
  echo "# [$filename] Taking screenshot..." >&3 2>/dev/null || true
  agent-browser screenshot "$SCREENSHOT_DIR/${filename}.png" 2>/dev/null || true
  agent-browser snapshot > "$SCREENSHOT_DIR/${filename}.txt" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# contains — Check if string contains pattern (case-insensitive)
# ---------------------------------------------------------------------------
contains() {
  [[ "$(echo "$1" | grep -ci "$2" 2>/dev/null)" -gt 0 ]]
}

# ---------------------------------------------------------------------------
# full_snapshot — Get full page snapshot text
# ---------------------------------------------------------------------------
full_snapshot() {
  agent-browser snapshot 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# click_continue — Click form "Continue" button (not "Continue with Google")
# ---------------------------------------------------------------------------
click_continue() {
  local snap_i ref
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  ref=$(echo "$snap_i" | grep -E 'button "Continue" \[ref=' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$ref" ]]; then
    agent-browser scrollintoview "$ref" 2>/dev/null || true
    agent-browser wait 300
    agent-browser click "$ref"
  else
    agent-browser find text "Continue" click
  fi
}

# ---------------------------------------------------------------------------
# dismiss_cookie_banner — Dismiss cookie consent banner if present
# ---------------------------------------------------------------------------
dismiss_cookie_banner() {
  if agent-browser find text "Accept" click 2>/dev/null; then
    agent-browser wait 500
  fi
}

# ---------------------------------------------------------------------------
# wait_for_otp_screen — Wait for verification/OTP screen to appear
# ---------------------------------------------------------------------------
wait_for_otp_screen() {
  local timeout_secs="${1:-10}"
  for _i in $(seq 1 "$timeout_secs"); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "verify\|verification code\|enter.*code"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# enter_otp — Enter OTP verification code
# ---------------------------------------------------------------------------
enter_otp() {
  local code="$1"

  if agent-browser find label "Enter verification code" fill "$code" 2>/dev/null; then
    : # filled via label
  elif agent-browser find placeholder "Enter verification code" fill "$code" 2>/dev/null; then
    : # filled via placeholder
  else
    # Fallback: find first input and press digits one by one
    agent-browser find first "input" click
    agent-browser wait 300
    for digit in $(echo "$code" | grep -o .); do
      agent-browser press "$digit"
    done
  fi
  agent-browser wait 2000

  # Click Continue/Verify button if present (needed when OTP is a single text input)
  if agent-browser find text "Continue" click 2>/dev/null; then
    : # clicked Continue
  elif agent-browser find text "Verify" click 2>/dev/null; then
    : # clicked Verify
  fi
  agent-browser wait 5000
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

  local email="e2e+clerk_test@vm0.ai"

  # Resolve user ID from email
  local users_response
  users_response=$(curl -sS -X GET \
    "https://api.clerk.com/v1/users?email_address[]=${email}" \
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
    "https://api.clerk.com/v1/sign_in_tokens" \
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
# derive_app_url — Derive platform app URL from VM0_API_URL
# Local:  https://www.vm7.ai:8443  → https://app.vm7.ai:8443
# CI:     https://pr-123-www.vm0-dev.com → https://pr-123-app.vm0-dev.com
# ---------------------------------------------------------------------------
derive_app_url() {
  echo "${VM0_API_URL/www./app.}"
}

# ---------------------------------------------------------------------------
# sign_in_via_token — Sign in via Clerk token and wait for redirect
# Requires SIGN_IN_TOKEN to be set (call create_clerk_sign_in_token first).
# ---------------------------------------------------------------------------
sign_in_via_token() {
  agent-browser open "${VM0_API_URL}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  agent-browser wait 3000

  # Wait for redirect away from /sign-in-token
  local redirect_complete=false
  for _i in $(seq 1 20); do
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if [[ -n "$current_url" && ! "$current_url" =~ sign-in-token ]]; then
      redirect_complete=true
      break
    fi
    sleep 1
  done

  if [[ "$redirect_complete" != "true" ]]; then
    echo "Failed to redirect after sign-in-token" >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# url_is_on_app — Check if a URL's hostname matches the APP_URL hostname
# Compares against the derived APP_URL rather than assuming "app." prefix,
# so it works for all environments (app.vm7.ai, staging-app.vm6.ai, etc.)
# Requires APP_URL to be set (call derive_app_url first).
# ---------------------------------------------------------------------------
url_is_on_app() {
  local url="$1"
  local url_host app_host
  url_host=$(echo "$url" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  app_host=$(echo "$APP_URL" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  [[ "$url_host" == "$app_host" ]]
}

# ---------------------------------------------------------------------------
# navigate_to_app_page — Navigate to a path on the platform app domain
# Usage: navigate_to_app_page "/team"
# ---------------------------------------------------------------------------
navigate_to_app_page() {
  local path="$1"
  local app_url
  app_url="$(derive_app_url)"
  agent-browser open "${app_url}${path}" --ignore-https-errors
  agent-browser wait 3000
}

# ---------------------------------------------------------------------------
# wait_for_text — Wait for text to appear on page (case-insensitive)
# Usage: wait_for_text "some text" [timeout_secs]
# ---------------------------------------------------------------------------
wait_for_text() {
  local text="$1"
  local timeout_secs="${2:-15}"
  for _i in $(seq 1 "$timeout_secs"); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "$text"; then
      return 0
    fi
    sleep 1
  done
  return 1
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
