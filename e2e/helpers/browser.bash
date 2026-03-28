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
# agent-browser — Wrapper that uses an isolated HOME when set.
# When AGENT_BROWSER_ISOLATED_HOME is exported (set by browser_setup), every
# agent-browser invocation runs with HOME pointing to a per-test temp dir so
# that parallel test files each own a separate daemon socket
# (~/<isolated_home>/.agent-browser/default.sock) and do not conflict.
# Falls back to the real command when AGENT_BROWSER_ISOLATED_HOME is unset.
# ---------------------------------------------------------------------------
agent-browser() {
  if [[ -n "${AGENT_BROWSER_ISOLATED_HOME:-}" ]]; then
    HOME="$AGENT_BROWSER_ISOLATED_HOME" command agent-browser "$@"
  else
    command agent-browser "$@"
  fi
}

# ---------------------------------------------------------------------------
# url_is_on_app — Check if a URL's hostname matches the expected app hostname
# Usage: url_is_on_app <url> [check_url]
#   check_url — URL to compare against (default: APP_URL from calling context)
# Compares hostnames rather than assuming "app." prefix, so it works for all
# environments (app.vm7.ai, staging-app.vm6.ai, etc.).
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
# stagger_parallel — Delay startup based on BATS_TEST_FILE_NUMBER (1, 2, 3, …).
# Call at the very start of setup_file() in each parallel test file to
# serialize Clerk token creation and sign-in across parallel workers.
# Without staggering, all workers create sign-in tokens simultaneously for
# the same Clerk account; Clerk appears to invalidate earlier tokens when
# a newer one is created, so only the last-created token succeeds.
#
# BATS sets BATS_TEST_FILE_NUMBER (1-based) via GNU parallel's {#} placeholder.
# ---------------------------------------------------------------------------
stagger_parallel() {
  # BATS_TEST_FILE_NUMBER is set by bats-exec-file (1-based job number from GNU parallel).
  local file_num="${BATS_TEST_FILE_NUMBER:-1}"
  local slot=$(( file_num - 1 ))
  if [[ "$slot" -gt 0 ]]; then
    local delay=$(( slot * 25 ))
    echo "# Job slot ${slot} (file #${file_num}): staggering startup by ${delay}s to avoid Clerk token conflicts..." >&3
    sleep "$delay"
  fi
}

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

  # Create an isolated HOME for agent-browser so that parallel test files each
  # own a separate daemon socket and do not conflict with each other.
  AGENT_BROWSER_ISOLATED_HOME="$(mktemp -d)"
  export AGENT_BROWSER_ISOLATED_HOME

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
    sleep 0.3
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
    sleep 0.5
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
    sleep 0.3
    for digit in $(echo "$code" | grep -o .); do
      agent-browser press "$digit"
    done
  fi
  sleep 2

  # Click Continue/Verify button if present (needed when OTP is a single text input)
  if agent-browser find text "Continue" click 2>/dev/null; then
    : # clicked Continue
  elif agent-browser find text "Verify" click 2>/dev/null; then
    : # clicked Verify
  fi
  sleep 5
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
# Usage: sign_in_via_token [base_url]
#   base_url — URL to sign in on (default: APP_URL, fallback: VM0_API_URL)
# ---------------------------------------------------------------------------
sign_in_via_token() {
  local base_url="${1:-${APP_URL:-$VM0_API_URL}}"
  agent-browser open "${base_url}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  # Allow extra time for first-run Chrome initialisation (cold start in CI).
  # Use shell sleep instead of agent-browser wait to avoid daemon IPC during
  # Chrome startup, which can crash the daemon under parallel CI load.
  sleep 10

  # Wait for token auth to complete and redirect away from /sign-in-token
  local auth_complete=false
  for _i in $(seq 1 60); do
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if url_is_on_app "$current_url" "$base_url" && [[ ! "$current_url" =~ sign-in-token ]]; then
      auth_complete=true
      break
    fi
    sleep 1
  done
  step_screenshot "after-auth-redirect"

  if [[ "$auth_complete" != "true" ]]; then
    echo "Failed to redirect after sign-in-token" >&2
    return 1
  fi

  # Dismiss cookie banner if present
  dismiss_cookie_banner
}

# ---------------------------------------------------------------------------
# sign_in_via_token_on_app — Sign in via Clerk token on the platform app domain
#
# Pre-visits the primary (www.) domain so Clerk JS initialises there before
# the satellite (app.) domain cross-domain session sync is attempted. Without
# this warm-up, fresh browser profiles hit the satellite sign-in-token route
# which redirects to www./sign-in?__clerk_db_jwt=... for session sync; the
# www. Clerk JS is not yet initialised and the redirect loop stalls.
#
# Requires APP_URL, VM0_API_URL, and SIGN_IN_TOKEN to be set.
# ---------------------------------------------------------------------------
sign_in_via_token_on_app() {
  echo "# Pre-loading www. domain to initialise Clerk JS for satellite sync..." >&3
  # Use || true: agent-browser exits non-zero when --ignore-https-errors is
  # passed to an already-running daemon (flag is silently ignored but nav still
  # completes). Real sign-in failures are caught by the retry block below.
  agent-browser open "${VM0_API_URL}" --ignore-https-errors 2>/dev/null || true
  # Use shell sleep instead of agent-browser wait to avoid daemon IPC during
  # page load — Chrome can crash the daemon under parallel CI load, and routing
  # a simple delay through the daemon adds an unnecessary failure point.
  sleep 5
  dismiss_cookie_banner

  echo "# Signing in via token on platform app (satellite) domain..." >&3
  if ! sign_in_via_token "$APP_URL"; then
    # Daemon may have crashed during sign-in — restart and retry once.
    echo "# sign_in_via_token failed, restarting daemon and retrying..." >&3
    restart_browser_daemon
    create_clerk_sign_in_token
    agent-browser open "${VM0_API_URL}" --ignore-https-errors 2>/dev/null || true
    sleep 5
    dismiss_cookie_banner
    sign_in_via_token "$APP_URL"
  fi
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
  # || true: agent-browser may exit non-zero for warnings (e.g., --ignore-https-errors
  # is silently ignored when the daemon is already running) even when the navigation
  # itself succeeds. Always return 0 so callers with `if !` do not fire false recovery.
  agent-browser open "${app_url}${path}" --ignore-https-errors 2>/dev/null || true
  sleep 3
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
# wait_for_text_gone — Wait for text to disappear from page (case-insensitive)
# Usage: wait_for_text_gone "some text" [timeout_secs]
# ---------------------------------------------------------------------------
wait_for_text_gone() {
  local text="$1"
  local timeout_secs="${2:-15}"
  for _i in $(seq 1 "$timeout_secs"); do
    local snap
    snap=$(full_snapshot)
    if ! contains "$snap" "$text"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# restart_browser_daemon — Fully stop the daemon process and clean up its socket
# so the next agent-browser command starts a completely fresh daemon.
#
# agent-browser close only closes the browser tab; the daemon process stays
# alive. If the daemon later crashes or is in a shutdown state, the socket
# file may still exist, causing the next command to fail with "Connection
# refused". This function kills the daemon PID and removes the socket to
# guarantee a clean start.
# ---------------------------------------------------------------------------
restart_browser_daemon() {
  echo "# Restarting browser daemon (full process restart)..." >&3 2>/dev/null || true
  agent-browser close 2>/dev/null || true
  sleep 1
  if [[ -n "${AGENT_BROWSER_ISOLATED_HOME:-}" ]]; then
    local pid_file="${AGENT_BROWSER_ISOLATED_HOME}/.agent-browser/default.pid"
    local sock_file="${AGENT_BROWSER_ISOLATED_HOME}/.agent-browser/default.sock"
    if [[ -f "$pid_file" ]]; then
      kill "$(cat "$pid_file" 2>/dev/null)" 2>/dev/null || true
    fi
    rm -f "$sock_file" "$pid_file" 2>/dev/null || true
  fi
  sleep 3
}

# ---------------------------------------------------------------------------
# browser_teardown — Kill agent-browser and any spawned browser processes
# Call this in teardown_file() to prevent bats from hanging.
# ---------------------------------------------------------------------------
browser_teardown() {
  # Close browser gracefully first
  agent-browser close 2>/dev/null || true

  if [[ -n "${AGENT_BROWSER_ISOLATED_HOME:-}" ]]; then
    # Isolated mode (parallel tests): kill only this test's daemon by PID so
    # we don't interfere with other concurrently-running test files.
    local pid_file="${AGENT_BROWSER_ISOLATED_HOME}/.agent-browser/default.pid"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid=$(cat "$pid_file" 2>/dev/null || true)
      [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    fi
    rm -rf "$AGENT_BROWSER_ISOLATED_HOME"
  else
    # Non-isolated mode (single sequential run): broad cleanup is safe.
    pkill -f 'agent-browser' 2>/dev/null || true
    pkill -f '[c]hrom(e|ium)' 2>/dev/null || true
  fi
}
