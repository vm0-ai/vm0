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
#   VM0_AUTH_URL   - Target auth URL (e.g., https://staging-so.vm6.ai)
#
# Optional env vars:
#   VM0_API_URL            - API URL, used as a local fallback for auth URL
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

  echo "# Clerk UI E2E (sign-up and sign-in)" >&3
  echo "#   Auth URL: ${VM0_AUTH_URL:-${VM0_API_URL:-}}" >&3
  echo "#   Auth domain: ${VM0_AUTH_DOMAIN:-<default>}" >&3
  echo "#   Auth redirect URL: ${VM0_AUTH_REDIRECT_URL:-<default>}" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
}

teardown_file() {
  browser_teardown
}

auth_url() {
  local path="$1"
  local base="${VM0_AUTH_URL:-${VM0_API_URL:-}}"
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
  local stuck_pattern="$1"
  local current_url snap

  for _i in $(seq 1 30); do
    current_url=$(agent-browser get url 2>/dev/null || true)
    if [[ -n "${VM0_AUTH_REDIRECT_URL:-}" && "$current_url" == "${VM0_AUTH_REDIRECT_URL}"* ]]; then
      return 0
    fi

    snap=$(full_snapshot)
    if [[ -z "${VM0_AUTH_REDIRECT_URL:-}" ]] && ! contains "$snap" "$stuck_pattern"; then
      return 0
    fi

    sleep 1
  done

  current_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Auth flow did not complete; current URL: ${current_url:-<unknown>}" >&3
  return 1
}

# ===========================================================================
# Phase 1: Sign up
# ===========================================================================

@test "sign up a new test account" {
  local sign_up_url
  sign_up_url="$(auth_url "/sign-up")"
  echo "# Navigating to $sign_up_url" >&3
  agent-browser open "$sign_up_url" --ignore-https-errors
  agent-browser wait 3000
  step_screenshot "sign-up-page"

  # Dismiss cookie consent banner early
  dismiss_cookie_banner

  # Wait for Clerk sign-up form
  echo "# Waiting for Clerk sign-up form..." >&3
  local form_appeared=false
  for _i in $(seq 1 10); do
    local snap
    snap=$(agent-browser snapshot -i 2>/dev/null || true)
    if contains "$snap" "email address"; then
      form_appeared=true
      break
    fi
    sleep 3
  done
  step_screenshot "sign-up-form"
  assert [ "$form_appeared" = "true" ]

  # Fill sign-up form
  echo "# Filling sign-up form with $E2E_ACCOUNT" >&3
  agent-browser find label "Email address" fill "$E2E_ACCOUNT"
  agent-browser wait 500
  agent-browser find label "Password" fill "$SIGNUP_PASSWORD"
  agent-browser wait 500
  accept_legal_consent
  click_continue
  agent-browser wait 5000
  step_screenshot "after-sign-up-continue"

  # Handle OTP verification if prompted
  local snap
  snap=$(full_snapshot)
  if contains "$snap" "verify your email\|verification code"; then
    enter_otp "$OTP"
    step_screenshot "after-sign-up-otp"
  fi

  wait_for_auth_completion "sign.up\|Create your account\|verification code"
  echo "# Sign-up successful!" >&3
}

# ===========================================================================
# Phase 2: Sign out and sign in
# ===========================================================================

@test "sign out and sign in with same account" {
  # Close browser session to clear auth state
  echo "# Closing browser to clear session..." >&3
  agent-browser close 2>/dev/null || true
  sleep 1

  # Re-open sign-in page
  local sign_in_url
  sign_in_url="$(auth_url "/sign-in")"
  echo "# Navigating to $sign_in_url" >&3
  agent-browser open "$sign_in_url" --ignore-https-errors
  agent-browser wait 3000
  step_screenshot "sign-in-page"

  dismiss_cookie_banner

  # Check if already signed in (redirected away from /sign-in)
  local current_url
  current_url=$(agent-browser get url 2>/dev/null || true)
  if [[ -n "$current_url" && ! "$current_url" =~ sign-in ]]; then
    echo "# Already signed in (redirected to $current_url)" >&3
    return 0
  fi

  # Wait for Clerk sign-in form
  echo "# Waiting for Clerk sign-in form..." >&3
  local form_appeared=false
  for _i in $(seq 1 10); do
    local snap
    snap=$(agent-browser snapshot -i 2>/dev/null || true)
    if contains "$snap" "email address"; then
      form_appeared=true
      break
    fi
    sleep 3
  done
  assert [ "$form_appeared" = "true" ]

  # Enter email and click Continue
  echo "# Entering email: $E2E_ACCOUNT" >&3
  agent-browser find label "Email address" fill "$E2E_ACCOUNT"
  agent-browser wait 500
  click_continue
  agent-browser wait 5000
  step_screenshot "after-email-continue"

  local snap
  snap=$(full_snapshot)

  # Handle password or OTP-based sign-in
  if contains "$snap" "password"; then
    echo "# Password screen detected - looking for email code option" >&3
    if agent-browser find text "Use another method" click 2>/dev/null \
        || agent-browser find text "use another method" click 2>/dev/null; then
      agent-browser wait 3000
      step_screenshot "after-alt-method-click"
      if agent-browser find text "Email code" click 2>/dev/null \
          || agent-browser find text "email code" click 2>/dev/null; then
        agent-browser wait 3000
      fi
    elif agent-browser find text "Forgot password" click 2>/dev/null \
        || agent-browser find text "forgot password" click 2>/dev/null; then
      agent-browser wait 3000
    fi
  fi

  # Wait for OTP screen, then enter code
  if ! wait_for_otp_screen 10; then
    step_screenshot "otp-screen-not-detected"
  fi

  enter_otp "$OTP"
  step_screenshot "after-sign-in-otp"

  wait_for_auth_completion "sign.in\|password\|verification code"
  echo "# Sign-in successful!" >&3
}
