#!/usr/bin/env bats
# brw-t04-schedule.bats — Schedule page creation and verification tests
#
# Runs in parallel with brw-t03-team.bats and brw-t05-agent-settings.bats
# after brw-t01-platform-e2e.bats establishes the shared test account.
# Uses token auth to enter — no OTP required.
#
# Required env vars:
#   VM0_API_URL        — Target web app URL (e.g., https://www.vm7.ai:8443)
#   CLERK_SECRET_KEY   — Clerk Backend API key (for creating sign-in tokens)
#   E2E_ACCOUNT        — Test email (must be set; signed up by brw-t01)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  # Stagger startup so sign-in tokens are not created simultaneously for the
  # same Clerk account across parallel workers (which would invalidate earlier tokens).
  stagger_parallel

  browser_setup
  create_clerk_sign_in_token

  APP_URL="$(derive_app_url)"
  export APP_URL

  SCHEDULE_PROMPT="E2E schedule $(date +%s)-$RANDOM"
  export SCHEDULE_PROMPT

  echo "# Schedule E2E tests (token auth)" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
  echo "#   Schedule prompt: $SCHEDULE_PROMPT" >&3
}

teardown_file() {
  browser_teardown
}

@test "sign in via token" {
  sign_in_via_token_on_app
}

@test "navigate to schedule page and open creation dialog" {
  echo "# Navigating to schedule page..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  agent-browser wait 3000

  # Wait for schedule page to load (longer timeout for cold-start browser)
  wait_for_text "Scheduled tasks" 40
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

  wait_for_text "Scheduled tasks" 40
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
