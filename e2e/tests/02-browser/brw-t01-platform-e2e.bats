#!/usr/bin/env bats
# brw-t01-platform-e2e.bats — Clerk UI sign-up and sign-in with a single test account
#
# These two tests specifically exercise the third-party Clerk form UI via
# agent-browser, which Playwright tests intentionally bypass:
#   1. Sign up a new test account via Clerk
#   2. Sign out, then sign in with the same account
#
# Tests 3-11 (token sign-in, onboarding, chat, team, automation) are covered
# by the Playwright suite and have been removed from this file.
#
# Required env vars:
#   VM0_AUTH_URL   - Target auth URL (e.g., https://pr-123-app.omby.ai)
#
# Optional env vars:
#   VM0_API_BACKEND_URL            - API URL, used as a local fallback for auth URL
#   VM0_AUTH_DOMAIN        - API domain override for auth callbacks
#   VM0_AUTH_REDIRECT_URL  - Post-auth app URL to verify Clerk completion
#   E2E_ACCOUNT            - Test email (auto-generated if empty)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  browser_setup

  # Generate a password for sign-up
  SIGNUP_PASSWORD="$(generate_password)"
  export SIGNUP_PASSWORD
  SIGN_UP_COMPLETE_FILE="${BATS_FILE_TMPDIR}/sign-up-complete"
  export SIGN_UP_COMPLETE_FILE

  echo "# Clerk UI E2E (sign-up and sign-in)" >&3
  echo "#   Auth URL: ${VM0_AUTH_URL:-${VM0_API_BACKEND_URL:-}}" >&3
  echo "#   Auth domain: ${VM0_AUTH_DOMAIN:-<default>}" >&3
  echo "#   Auth redirect URL: ${VM0_AUTH_REDIRECT_URL:-<default>}" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
}

teardown_file() {
  browser_teardown
}

auth_url() {
  local path="$1"
  local base="${VM0_AUTH_URL:-${VM0_API_BACKEND_URL:-}}"
  local url="${base%/}${path}"

  if [[ -n "${VM0_AUTH_REDIRECT_URL:-}" ]]; then
    local separator="?"
    if [[ "$url" == *\?* ]]; then
      separator="&"
    fi
    url="${url}${separator}redirect_url=$(encode_uri_component "$VM0_AUTH_REDIRECT_URL")"
  fi

  if [[ -n "${VM0_AUTH_DOMAIN:-}" ]]; then
    local separator="?"
    if [[ "$url" == *\?* ]]; then
      separator="&"
    fi
    url="${url}${separator}domain=$(encode_uri_component "$VM0_AUTH_DOMAIN")"
  fi

  printf '%s' "$url"
}

encode_uri_component() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

wait_for_auth_completion() {
  local auth_path="$1"

  if [[ -n "${VM0_AUTH_REDIRECT_URL:-}" ]]; then
    local redirect_url_json
    redirect_url_json=$(node -e \
      'process.stdout.write(JSON.stringify(process.argv[1]))' \
      "$VM0_AUTH_REDIRECT_URL")
    wait_for_browser_target --fn \
      "window.location.href.startsWith(${redirect_url_json})"
    return
  fi

  wait_for_browser_target --fn \
    "!window.location.pathname.includes('/${auth_path}')"
}

open_auth_form() {
  local url="$1"
  local target_expression="$2"

  agent-browser open "$url"
  if wait_for_browser_target --timeout-seconds 30 --fn "$target_expression"; then
    return
  fi

  report_auth_page_failure

  # A failed app module request leaves the static HTML bootstrap skeleton in
  # place before Clerk exists. Recover that transport failure once without
  # masking a Clerk form stall after the application has started.
  if [[ "$(agent-browser eval \
    "Boolean(
      document.getElementById('app-bootstrap-skeleton')
      && typeof window.Clerk === 'undefined'
    )")" != "true" ]]; then
    return 1
  fi

  echo "# App bootstrap did not complete; reloading once" >&3
  agent-browser reload
  if ! wait_for_browser_target --timeout-seconds 30 --fn "$target_expression"; then
    report_auth_page_failure
    return 1
  fi
  echo "# App bootstrap recovered after reload" >&3
}

# ===========================================================================
# Phase 1: Sign up
# ===========================================================================

@test "sign up a new test account" {
  local sign_up_url
  sign_up_url="$(auth_url "/sign-up")"
  echo "# Navigating to $sign_up_url" >&3
  open_auth_form "$sign_up_url" \
    "Boolean(
      document.querySelector('input[name=\"emailAddress\"]')
      && document.querySelector('input[name=\"password\"]')
    )"
  dismiss_cookie_banner

  # Fill sign-up form
  echo "# Filling sign-up form with $E2E_ACCOUNT" >&3
  agent-browser fill 'input[name="emailAddress"]' "$E2E_ACCOUNT"
  agent-browser fill 'input[name="password"]' "$SIGNUP_PASSWORD"
  accept_legal_consent
  click_continue

  local sign_up_state
  sign_up_state="$(wait_for_auth_next_step "sign-up")"
  if [[ "$sign_up_state" == "otp" ]]; then
    enter_otp "$OTP" "sign-up"
    wait_for_auth_completion "sign-up"
  fi
  touch "$SIGN_UP_COMPLETE_FILE"
  echo "# Sign-up successful!" >&3
}

# ===========================================================================
# Phase 2: Sign out and sign in
# ===========================================================================

@test "sign out and sign in with same account" {
  if [[ ! -f "$SIGN_UP_COMPLETE_FILE" ]]; then
    echo "# Sign-in prerequisite failed: sign-up did not complete" >&3
    return 1
  fi

  # Start a fresh isolated session so auth state cannot leak across cases.
  agent-browser close 2>/dev/null || true
  export AGENT_BROWSER_SESSION="${JOB_REF:-local}-sign-in"
  browser_setup

  # Re-open sign-in page
  local sign_in_url
  sign_in_url="$(auth_url "/sign-in")"
  echo "# Navigating to $sign_in_url" >&3
  open_auth_form "$sign_in_url" \
    "!window.location.pathname.includes('/sign-in')
      || Boolean(document.querySelector('input[name=\"identifier\"]'))"

  # Check if already signed in (redirected away from /sign-in)
  local current_url
  current_url=$(agent-browser get url 2>/dev/null || true)
  if [[ -n "$current_url" && ! "$current_url" =~ sign-in ]]; then
    echo "# Already signed in (redirected to $current_url)" >&3
    return 0
  fi

  dismiss_cookie_banner

  # Enter email and click Continue
  echo "# Entering email: $E2E_ACCOUNT" >&3
  agent-browser fill 'input[name="identifier"]' "$E2E_ACCOUNT"
  click_continue

  local sign_in_state
  sign_in_state="$(wait_for_auth_next_step "sign-in")"
  if [[ "$sign_in_state" == "complete" ]]; then
    echo "# Sign-in completed after email submit" >&3
    return 0
  fi

  if [[ "$sign_in_state" == "password" ]]; then
    wait_for_browser_target --fn \
      "document.body.innerText.toLowerCase().includes('use another method')
        || document.body.innerText.toLowerCase().includes('forgot password')"
    if [[ "$(agent-browser eval \
      "document.body.innerText.toLowerCase().includes('use another method')")" == "true" ]]; then
      agent-browser find text "Use another method" click
      wait_for_browser_target --text "Email code"
      agent-browser find text "Email code" click
    else
      agent-browser find text "Forgot password" click
    fi
  fi

  enter_otp "$OTP" "sign-in"
  wait_for_auth_completion "sign-in"
  echo "# Sign-in successful!" >&3
}
