#!/usr/bin/env bats
# brw-t01-platform-e2e.bats — Auth and onboarding (serial, runs first)
#
# Establishes the shared test account used by all browser E2E tests:
#   1. Pre-clean: delete E2E_ACCOUNT from Clerk if it already exists
#   2. Sign up a new test account via Clerk
#   3. Sign out, then sign in with the same account (tests OTP sign-in flow)
#   4. Sign out, then sign in via Clerk token (API-based auth)
#   5. Complete onboarding (if needed)
#   6. Verify chat page
#
# After this file completes, the account is signed up, onboarded, and ready.
# Independent functional tests (team, schedule, agent settings) run in
# parallel after this file, each using token auth to enter.
#
# Required env vars:
#   VM0_API_URL        — Target web app URL (e.g., https://www.vm7.ai:8443)
#   CLERK_SECRET_KEY   — Clerk Backend API key (for creating sign-in tokens)
#
# Optional env vars:
#   E2E_ACCOUNT        — Test email (auto-generated if empty)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  browser_setup

  APP_URL="$(derive_app_url)"
  export APP_URL

  # Generate a password for sign-up
  SIGNUP_PASSWORD="$(generate_password)"
  export SIGNUP_PASSWORD

  echo "# Platform E2E: auth + onboarding (single account)" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3

  # Pre-clean: remove stale account from a previous run before signing up
  echo "# Pre-cleaning stale account if it exists..." >&3
  delete_e2e_account_if_exists || true
}

teardown_file() {
  browser_teardown
  # Account cleanup is handled by the CI "Cleanup test accounts" step.
  # delete_e2e_account_if_exists is also called at the start of the next run.
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

# ===========================================================================
# Phase 3: Token-based sign in
# ===========================================================================

@test "sign out and sign in via Clerk token" {
  # Create sign-in token for the test account (now exists after sign-up)
  echo "# Creating sign-in token for $E2E_ACCOUNT..." >&3
  create_clerk_sign_in_token "$E2E_ACCOUNT"

  # Close browser session to clear auth state
  echo "# Closing browser to clear session..." >&3
  agent-browser close 2>/dev/null || true
  sleep 1

  echo "# Signing in via token..." >&3
  sign_in_via_token "$APP_URL"
  step_screenshot "after-token-sign-in"

  # Verify signed-in state on app domain
  local current_url
  current_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Current URL: $current_url" >&3
  url_is_on_app "$current_url"
  [[ ! "$current_url" =~ sign-in-token ]]
  echo "# Token sign-in successful!" >&3
}

# ===========================================================================
# Phase 4: Onboarding and chat
# ===========================================================================

@test "detect and complete onboarding" {
  # Wait for platform content to load
  echo "# Waiting for platform content..." >&3
  agent-browser wait 3000

  local snap
  local needs_onboarding=false

  for _i in $(seq 1 20); do
    snap=$(full_snapshot)
    if contains "$snap" "Name your workspace\|Choose your tools\|Connect your apps\|Where would you like to work"; then
      needs_onboarding=true
      break
    fi
    if contains "$snap" "Ask me to automate workflows\|Ideas.*use cases\|Browse use cases"; then
      echo "# Already onboarded — chat page detected" >&3
      break
    fi
    sleep 1
  done
  step_screenshot "platform-state"

  if [[ "$needs_onboarding" != "true" ]]; then
    echo "# Skipping onboarding: user already onboarded" >&3
    skip "User already onboarded"
  fi

  # --- Step 1: Name your workspace ---
  if contains "$snap" "Name your workspace"; then
    echo "# Step 1: Naming workspace..." >&3
    step_screenshot "onboard-step1"
    agent-browser find placeholder "e.g. Acme Corp" fill "E2E Test Workspace"
    agent-browser wait 500
    agent-browser find text "Next" click
    agent-browser wait 2000
    step_screenshot "onboard-step1-done"
    snap=$(full_snapshot)
  fi

  # --- Step 2: Choose your tools ---
  if contains "$snap" "Choose your tools"; then
    echo "# Step 2: Choosing tools (skip, click Next)..." >&3
    step_screenshot "onboard-step2"
    agent-browser find text "Next" click
    agent-browser wait 2000
    step_screenshot "onboard-step2-done"
    snap=$(full_snapshot)
  fi

  # --- Step 3: Connect your apps ---
  if contains "$snap" "Connect your apps"; then
    echo "# Step 3: Connect apps (skip, click Next)..." >&3
    step_screenshot "onboard-step3"
    agent-browser find text "Next" click
    agent-browser wait 2000
    step_screenshot "onboard-step3-done"
    snap=$(full_snapshot)
  fi

  # --- Step 4: Where to work ---
  if contains "$snap" "Where would you like to work\|Continue in web"; then
    echo "# Step 4: Choosing 'Continue in web'..." >&3
    step_screenshot "onboard-step4"
    agent-browser find text "Continue in web" click
    agent-browser wait 8000
    step_screenshot "onboard-step4-done"
  fi

  echo "# Onboarding complete!" >&3
}

@test "verify chat page is displayed" {
  echo "# Verifying chat page..." >&3

  local chat_loaded=false
  for _i in $(seq 1 30); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Ask me to automate workflows"; then
      chat_loaded=true
      break
    fi
    if contains "$snap" "Ideas.*use cases\|Browse use cases"; then
      chat_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "chat-page-final"

  assert [ "$chat_loaded" = "true" ]

  # Verify URL is on the platform app domain
  local final_url
  final_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Final URL: $final_url" >&3
  url_is_on_app "$final_url"
  [[ ! "$final_url" =~ sign-in ]]
  [[ ! "$final_url" =~ onboarding ]]

  # Wait for workspace to be fully ready: navigate to /team and poll for the
  # Lead agent badge. Workspace initialization is async after onboarding; the
  # chat page may appear before the Lead agent is created. Parallel tests
  # (brw-t03, brw-t04) must not start until this is confirmed ready.
  echo "# Waiting for workspace to be fully ready (Lead on /team)..." >&3
  navigate_to_app_page "/team"
  local workspace_ready=false
  for _attempt in 1 2 3; do
    if wait_for_text "Lead" 30; then
      workspace_ready=true
      break
    fi
    echo "# Attempt ${_attempt}: Lead not found yet, reloading /team..." >&3
    navigate_to_app_page "/team"
  done
  step_screenshot "team-page-workspace-ready"
  assert [ "$workspace_ready" = "true" ]
  echo "# Workspace ready — Lead agent confirmed on /team" >&3
}

# Team page and schedule page tests are in separate files (brw-t03-team.bats,
# brw-t04-schedule.bats) and run in parallel after this file completes.
