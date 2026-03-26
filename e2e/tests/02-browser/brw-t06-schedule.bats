#!/usr/bin/env bats
# brw-t06-schedule.bats — Verify schedule creation, detail page, and calendar view
#
# Tests the full schedule lifecycle: create → verify detail page → edit field
# → save → verify in calendar view. Uses token-based auth for fast, reliable
# sign-in.
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

@test "navigate to schedule page and create schedule" {
  echo "# Navigating to schedule page..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  agent-browser wait 3000

  # Wait for schedule page to load
  wait_for_text "Scheduled tasks" 20
  step_screenshot "schedule-page"

  # Click "Add schedule" button (use role locator; text inside button has an icon sibling)
  # Retry because agents may still be loading (header button is disabled until agents load)
  echo "# Clicking Add schedule..." >&3
  local btn_clicked=false
  for _i in $(seq 1 15); do
    if agent-browser find role button --name "Add schedule" click 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  assert [ "$btn_clicked" = "true" ]
  agent-browser wait 1000

  # Wait for dialog to appear
  wait_for_text "Describe your task and instruction" 10
  step_screenshot "add-schedule-dialog"

  # Fill the prompt textarea
  echo "# Filling schedule prompt: $SCHEDULE_PROMPT" >&3
  agent-browser find placeholder "Describe your task and instruction" fill "$SCHEDULE_PROMPT"
  agent-browser wait 500
  step_screenshot "schedule-form-filled"

  # Click Create button (use role locator for consistency)
  echo "# Clicking Create..." >&3
  agent-browser find role button --name "Create" click

  # Wait for navigation to detail page
  local navigated=false
  for _i in $(seq 1 30); do
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if [[ "$current_url" =~ /schedule/ ]] && [[ ! "$current_url" =~ /schedule$ ]]; then
      navigated=true
      break
    fi
    sleep 1
  done
  step_screenshot "after-create"
  assert [ "$navigated" = "true" ]
  echo "# Schedule created and navigated to detail page!" >&3
}

@test "verify schedule detail page shows correct data" {
  echo "# Verifying detail page content..." >&3

  wait_for_text "$SCHEDULE_PROMPT" 20
  step_screenshot "detail-page"
  echo "# Schedule prompt verified on detail page!" >&3
}

@test "edit description field and verify save" {
  echo "# Editing description field..." >&3

  # Fill the description input
  agent-browser find placeholder "Leave blank to auto-generate" fill "E2E test description"
  agent-browser wait 1000

  # Wait for the unsaved changes bar (Save button) to appear
  wait_for_text "Save" 10
  step_screenshot "unsaved-changes"

  # Click Save
  echo "# Saving changes..." >&3
  agent-browser find text "Save" click

  # Wait for save to complete (Save button should disappear)
  local save_done=false
  for _i in $(seq 1 15); do
    local snap
    snap=$(full_snapshot)
    if ! contains "$snap" "Discard"; then
      save_done=true
      break
    fi
    sleep 1
  done
  step_screenshot "after-save"
  assert [ "$save_done" = "true" ]
  echo "# Description saved successfully!" >&3
}

@test "navigate to calendar view and verify schedule appears" {
  echo "# Navigating to schedule list..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  agent-browser wait 3000

  # Wait for schedule page
  wait_for_text "Scheduled tasks" 20

  # Click Calendar tab (use role locator; tab text has an icon sibling)
  echo "# Switching to Calendar view..." >&3
  local tab_clicked=false
  for _i in $(seq 1 10); do
    if agent-browser find role tab --name "Calendar" click 2>/dev/null; then
      tab_clicked=true
      break
    fi
    sleep 1
  done
  assert [ "$tab_clicked" = "true" ]
  agent-browser wait 2000

  # Wait for calendar to render
  wait_for_text "Week view" 15
  step_screenshot "calendar-view"

  # Verify schedule appears in calendar
  wait_for_text "$SCHEDULE_PROMPT" 10
  step_screenshot "calendar-with-schedule"
  echo "# Schedule verified in calendar view!" >&3
}
