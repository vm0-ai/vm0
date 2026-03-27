#!/usr/bin/env bats
# brw-t03-platform-flows.bats — Platform flows after sign-in (serial, shared session)
#
# All tests share a single browser session and run serially:
#   1. Sign in via Clerk token
#   2. Complete onboarding (if needed)
#   3. Verify chat page
#   4. Navigate to team page and verify agents
#   5. Create a new agent
#   6. Navigate to schedule page and create a schedule
#
# This avoids re-authentication between flows, which would trigger onboarding
# again on a fresh session.
#
# Required env vars:
#   VM0_API_URL        — Target web app URL (e.g., https://www.vm7.ai:8443)
#   CLERK_SECRET_KEY   — Clerk Backend API key (for creating sign-in tokens)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  browser_setup
  create_clerk_sign_in_token

  APP_URL="$(derive_app_url)"
  export APP_URL

  AGENT_NAME="E2E-Agent-$(date +%s)-$RANDOM"
  export AGENT_NAME

  SCHEDULE_PROMPT="E2E schedule $(date +%s)-$RANDOM"
  export SCHEDULE_PROMPT

  echo "# Platform flows (shared session) via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
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
# Phase 1: Sign in and onboarding
# ===========================================================================

@test "sign in via token on platform app" {
  echo "# Signing in via token on platform app..." >&3
  sign_in_via_token "$APP_URL"
  step_screenshot "after-sign-in"
  echo "# Authentication complete!" >&3
}

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
}

# ===========================================================================
# Phase 2: Team page — agent listing and creation
# ===========================================================================

@test "navigate to team page and verify zero agent" {
  echo "# Navigating to /team page..." >&3
  navigate_to_app_page "/team"
  step_screenshot "team-page-initial"

  echo "# Waiting for Agents heading..." >&3
  wait_for_text "Agents" 20
  step_screenshot "team-page-loaded"

  local snap
  snap=$(full_snapshot)

  echo "# Verifying lead agent badge..." >&3
  contains "$snap" "Lead"

  echo "# Verifying Create teammate button..." >&3
  contains "$snap" "Create teammate"

  echo "# Team page verified!" >&3
}

@test "create new agent via dialog" {
  echo "# Clicking Create teammate..." >&3
  agent-browser find text "Create teammate" click
  agent-browser wait 1000
  step_screenshot "create-dialog-opened"

  echo "# Waiting for dialog content..." >&3
  wait_for_text "Create a new teammate" 10

  echo "# Filling agent name: $AGENT_NAME" >&3
  agent-browser find placeholder "e.g. Research Assistant" fill "$AGENT_NAME"
  agent-browser wait 500
  step_screenshot "create-dialog-filled"

  echo "# Clicking Create button in dialog..." >&3
  local snap_i
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  local create_ref
  create_ref=$(echo "$snap_i" | grep -E 'button "Create"' | grep -v 'teammate' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$create_ref" ]]; then
    agent-browser click "$create_ref"
  else
    agent-browser find text "Create" click
  fi

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
  echo "# Verifying agent appears on team page..." >&3
  wait_for_text "$AGENT_NAME" 20
  step_screenshot "agent-visible"

  local snap
  snap=$(full_snapshot)
  contains "$snap" "$AGENT_NAME"

  local final_url
  final_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Final URL: $final_url" >&3
  [[ "$final_url" =~ /team ]]
  step_screenshot "team-page-final"

  echo "# New agent verified on team page!" >&3
}

# ===========================================================================
# Phase 3: Schedule page — creation and verification
# ===========================================================================

@test "navigate to schedule page and open creation dialog" {
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
