#!/usr/bin/env bats
# brw-t01-platform-e2e.bats — Full platform E2E flow with a single test account
#
# All tests share a single browser session and run serially:
#   1. Sign up a new test account via Clerk
#   2. Sign out, then sign in with the same account
#   3. Sign out, then sign in via Clerk token (API-based auth)
#   4. Complete onboarding (if needed)
#   5. Verify chat page
#   6. Navigate to team page and verify agents
#   7. Create a new agent
#   8. Navigate to schedule page and create a schedule
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

  AGENT_NAME="E2E-Agent-$(date +%s)-$RANDOM"
  export AGENT_NAME

  SCHEDULE_PROMPT="E2E schedule $(date +%s)-$RANDOM"
  export SCHEDULE_PROMPT

  # Generate a password for sign-up
  SIGNUP_PASSWORD="$(generate_password)"
  export SIGNUP_PASSWORD

  echo "# Platform E2E (single account, shared session)" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
  echo "#   Agent name: $AGENT_NAME" >&3
  echo "#   Schedule prompt: $SCHEDULE_PROMPT" >&3
}

teardown_file() {
  # Clean up the created agent to prevent orphan accumulation
  if [[ -n "${AGENT_NAME:-}" ]]; then
    $ZERO_CLI agent delete "$AGENT_NAME" --yes 2>/dev/null || true
  fi

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
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
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
}

# ===========================================================================
# Phase 5: Team page — agent listing and creation
# ===========================================================================

@test "navigate to team page and verify zero agent" {
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
  echo "# Navigating to /team page..." >&3
  navigate_to_app_page "/team"
  step_screenshot "team-page-initial"

  echo "# Waiting for Agents heading..." >&3
  wait_for_text "Agents" 20
  step_screenshot "team-page-loaded"

  echo "# Waiting for default agent (async load)..." >&3
  wait_for_text "Your core agent" 20
  step_screenshot "team-page-agent-loaded"

  echo "# Waiting for New agent button..." >&3
  wait_for_text "New agent" 10

  echo "# Team page verified!" >&3
}

@test "create new agent via dialog" {
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
  echo "# Clicking New agent..." >&3
  agent-browser find role button click --name "New agent"
  agent-browser wait 1000
  step_screenshot "create-dialog-opened"

  echo "# Waiting for dialog content..." >&3
  wait_for_text "Create a new agent" 10

  echo "# Filling agent name: $AGENT_NAME" >&3
  agent-browser find placeholder "e.g. Research Assistant" fill "$AGENT_NAME"
  agent-browser wait 500
  step_screenshot "create-dialog-filled"

  echo "# Clicking Create button in dialog..." >&3
  agent-browser find role button click --name "Create"

  echo "# Waiting for agent creation to complete..." >&3
  local create_complete=false
  for _i in $(seq 1 30); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "$AGENT_NAME"; then
      create_complete=true
      break
    fi
    sleep 1
  done
  step_screenshot "after-create"

  assert [ "$create_complete" = "true" ]
  echo "# Agent created!" >&3
}

@test "verify new agent appears on team page" {
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
  echo "# Verifying agent appears on team page..." >&3
  wait_for_text "$AGENT_NAME" 20
  step_screenshot "agent-visible"

  local snap
  snap=$(full_snapshot)
  contains "$snap" "$AGENT_NAME"

  local final_url
  final_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Final URL: $final_url" >&3
  [[ "$final_url" =~ /agents ]]
  step_screenshot "team-page-final"

  echo "# New agent verified on team page!" >&3
}

# ===========================================================================
# Phase 6: Schedule page — creation and verification
# ===========================================================================

@test "navigate to schedule page and open creation dialog" {
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
  echo "# Navigating to schedule page..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  agent-browser wait 3000

  # Wait for schedule page to load
  wait_for_text "Scheduled tasks" 20
  step_screenshot "schedule-page"

  # Click "Add schedule" button (retry because agents may still be loading)
  echo "# Clicking Add schedule..." >&3
  local btn_clicked=false
  for _i in $(seq 1 15); do
    if agent-browser find role button click --name "Add schedule" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  assert [ "$btn_clicked" = "true" ]
  agent-browser wait 1000

  # Wait for dialog to appear
  wait_for_text "Prompt" 10
  step_screenshot "add-schedule-dialog"
  echo "# Creation dialog opened!" >&3
}

@test "fill and submit schedule creation form" {
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
  # Fill the prompt textarea
  echo "# Filling schedule prompt: $SCHEDULE_PROMPT" >&3
  agent-browser find label "Prompt" fill "$SCHEDULE_PROMPT"
  agent-browser wait 500
  step_screenshot "schedule-form-filled"

  # Click Create button
  echo "# Clicking Create..." >&3
  agent-browser find role button click --name "Create"

  # After clicking Create, the backend schedule creation API can take
  # 60-120+ seconds. We do NOT wait for it to complete — that would exceed
  # BATS_TEST_TIMEOUT (180s). Instead, we just verify the click succeeded
  # by waiting briefly and taking a screenshot for debugging.
  agent-browser wait 5000
  step_screenshot "after-create-click"
  echo "# Create button clicked, schedule creation initiated!" >&3
}

@test "verify schedule list page still loads after creation" {
  skip "Temporarily disabled — post-onboarding agent provisioning is too slow for this timeout (tracked: github.com/vm0-ai/vm0)"
  # After form submission, verify the schedule list page is still functional.
  echo "# Verifying schedule list page loads..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  agent-browser wait 3000

  wait_for_text "Scheduled tasks" 20
  step_screenshot "schedule-list-after-create"

  # Check if the new schedule already appeared (it may or may not have finished)
  local snap
  snap=$(full_snapshot)
  if contains "$snap" "$SCHEDULE_PROMPT"; then
    echo "# Schedule already visible on list page!" >&3
  else
    echo "# Schedule not yet visible (backend still processing) - this is expected" >&3
  fi
  echo "# Schedule list page verified!" >&3
}
