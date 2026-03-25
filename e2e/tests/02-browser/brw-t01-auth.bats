#!/usr/bin/env bats
# brw-t01-auth.bats — Verify Clerk sign-up and sign-in via agent-browser
#
# Required env vars:
#   VM0_API_URL   — Target site URL
#
# Optional env vars:
#   E2E_ACCOUNT   — Test email (auto-generated if empty)

load '../../helpers/setup'
load '../../helpers/browser'

# ---------------------------------------------------------------------------
# File-level setup: initialize browser helpers
# ---------------------------------------------------------------------------
setup_file() {
  browser_setup

  echo "# Browser auth verification via agent-browser" >&3
  echo "#   URL:   $VM0_API_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
}

# ---------------------------------------------------------------------------
# File-level teardown: kill browser processes so bats can exit cleanly
# ---------------------------------------------------------------------------
teardown_file() {
  browser_teardown
}

# ===========================================================================
# Test 1: Clerk sign-in (or sign-up) via browser
# ===========================================================================
@test "sign up or sign in via Clerk" {
  echo "# Navigating to $VM0_API_URL/sign-in" >&3
  agent-browser open "$VM0_API_URL/sign-in" --ignore-https-errors
  agent-browser wait 3000
  step_screenshot "sign-in-page"

  # Check if already signed in (redirected away from /sign-in)
  local current_url
  current_url=$(agent-browser get url 2>/dev/null || true)
  if [[ -n "$current_url" && ! "$current_url" =~ sign-in ]]; then
    echo "# Already signed in (redirected to $current_url)" >&3
    return 0
  fi

  # Dismiss cookie consent banner early to prevent it from blocking clicks
  dismiss_cookie_banner

  # Wait for Clerk sign-in form
  echo "# Waiting for Clerk sign-in form..." >&3
  local form_appeared=false
  for i in $(seq 1 10); do
    local snap
    snap=$(agent-browser snapshot -i 2>/dev/null || true)
    if contains "$snap" "email address"; then
      form_appeared=true
      break
    fi
    if [[ $i -eq 10 ]]; then
      step_screenshot "sign-in-form-missing"
    fi
    sleep 3
  done
  assert [ "$form_appeared" = "true" ]

  # Enter email on sign-in form and click Continue
  echo "# Entering email: $E2E_ACCOUNT" >&3
  agent-browser find label "Email address" fill "$E2E_ACCOUNT"
  agent-browser wait 500
  click_continue
  agent-browser wait 5000
  step_screenshot "after-email-continue"

  # Decide: sign-in succeeded, need sign-up, or need OTP?
  local snap
  snap=$(full_snapshot)

  if contains "$snap" "identifier is invalid\|couldn.t find your account"; then
    # ---- Account does not exist -> sign-up flow ----
    step_screenshot "account-not-found"
    echo "# Account not found - switching to sign-up flow" >&3

    local signup_password
    signup_password="$(generate_password)"

    agent-browser open "$VM0_API_URL/sign-up" --ignore-https-errors
    agent-browser wait 3000

    local signup_form_appeared=false
    for i in $(seq 1 10); do
      snap=$(agent-browser snapshot -i 2>/dev/null || true)
      if contains "$snap" "email address"; then
        signup_form_appeared=true
        break
      fi
      if [[ $i -eq 10 ]]; then
        step_screenshot "sign-up-form-missing"
      fi
      sleep 3
    done
    assert [ "$signup_form_appeared" = "true" ]

    step_screenshot "sign-up-form"
    echo "# Filling sign-up form" >&3
    agent-browser find label "Email address" fill "$E2E_ACCOUNT"
    agent-browser wait 500
    agent-browser find label "Password" fill "$signup_password"
    agent-browser wait 500
    click_continue
    agent-browser wait 5000
    step_screenshot "after-sign-up-continue"

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

  elif ! contains "$snap" "sign.in\|password\|email address"; then
    # ---- Page no longer shows sign-in form -> already authenticated ----
    echo "# Sign-in successful!" >&3

  else
    # ---- Still on sign-in page -> need OTP to complete sign-in ----
    step_screenshot "sign-in-needs-otp"
    echo "# Sign-in requires further verification" >&3

    # If password field is showing, try to switch to email code method
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
  fi
}
