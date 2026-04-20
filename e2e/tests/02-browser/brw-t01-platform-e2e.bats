#!/usr/bin/env bats
# brw-t01-platform-e2e.bats — Clerk UI sign-up and sign-in with a single test account
#
# These two tests specifically exercise the third-party Clerk form UI via
# agent-browser, which Playwright tests intentionally bypass:
#   1. Sign up a new test account via Clerk
#   2. Sign out, then sign in with the same account
#
# Tests 3-11 (token sign-in, onboarding, chat, team, schedule) are covered
# by the Playwright suite and have been removed from this file.
#
# Required env vars:
#   VM0_API_URL   — Target web app URL (e.g., https://www.vm7.ai:8443)
#
# Optional env vars:
#   E2E_ACCOUNT   — Test email (auto-generated if empty)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  browser_setup

  # Generate a password for sign-up
  SIGNUP_PASSWORD="$(generate_password)"
  export SIGNUP_PASSWORD

  echo "# Clerk UI E2E (sign-up and sign-in)" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
}

teardown_file() {
  browser_teardown
}

# ===========================================================================
# Phase 1: Sign up
# ===========================================================================

@test "sign up a new test account" {
  echo "# Navigating to $VM0_API_URL/sign-up" >&3
  agent-browser open "$VM0_API_URL/sign-up" --ignore-https-errors
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

  # Wait for sign-up to complete
  for _i in $(seq 1 30); do
    snap=$(full_snapshot)
    if ! contains "$snap" "sign.up\|Create your account\|verification code"; then
      break
    fi
    sleep 1
  done

  snap=$(full_snapshot)
  assert [ "$(contains "$snap" "sign.up\|Create your account" && echo "stuck" || echo "ok")" = "ok" ]
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
  echo "# Navigating to $VM0_API_URL/sign-in" >&3
  agent-browser open "$VM0_API_URL/sign-in" --ignore-https-errors
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

  # Wait for sign-in to complete
  for _i in $(seq 1 30); do
    snap=$(full_snapshot)
    if ! contains "$snap" "sign.in\|password\|verification code"; then
      break
    fi
    sleep 1
  done

  snap=$(full_snapshot)
  assert [ "$(contains "$snap" "sign.in\|password" && echo "stuck" || echo "ok")" = "ok" ]
  echo "# Sign-in successful!" >&3
}
