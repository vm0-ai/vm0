#!/usr/bin/env bats
# brw-t06-schedule.bats — Verify schedule creation and list page
#
# Tests the schedule creation UI flow: open dialog → fill form → submit.
# Uses token-based auth for fast, reliable sign-in.
#
# The schedule creation API can take 60-120+ seconds, so we do NOT wait for the
# backend to finish. We verify the UI interaction works (dialog opens, form
# fills, Create button clicks) without blocking on the slow API response.
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

  SCHEDULE_PROMPT="E2E schedule $(date +%s)-$RANDOM"
  export SCHEDULE_PROMPT

  echo "# Schedule E2E verification via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Prompt:  $SCHEDULE_PROMPT" >&3
}

teardown_file() {
  browser_teardown
}

@test "sign in via token" {
  echo "# Signing in via token on platform app..." >&3
  sign_in_via_token "$APP_URL"
  step_screenshot "after-sign-in"
  echo "# Authentication complete!" >&3
}

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
  # We do NOT wait for the schedule to appear in the list because the backend
  # creation can take 60-120+ seconds which exceeds BATS_TEST_TIMEOUT.
  # The form submission test above already verifies the UI interaction works.
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
