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
  agent-browser open "${APP_URL}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  agent-browser wait 5000
  step_screenshot "sign-in-token"

  # Wait for token auth to complete and redirect away from /sign-in-token
  echo "# Waiting for auth redirect..." >&3
  local auth_complete=false
  for _i in $(seq 1 30); do
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if url_is_on_app "$current_url" && [[ ! "$current_url" =~ sign-in-token ]]; then
      auth_complete=true
      break
    fi
    sleep 1
  done
  step_screenshot "after-auth-redirect"

  assert [ "$auth_complete" = "true" ]
  echo "# Authentication complete!" >&3

  # Dismiss cookie banner if present
  dismiss_cookie_banner
}

@test "navigate to schedule page and create schedule" {
  echo "# Navigating to schedule page..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  agent-browser wait 3000

  # Wait for schedule page to load
  local page_loaded=false
  for _i in $(seq 1 20); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Scheduled tasks"; then
      page_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "schedule-page"
  assert [ "$page_loaded" = "true" ]

  # Click "Add schedule" button
  echo "# Clicking Add schedule..." >&3
  agent-browser find text "Add schedule" click
  agent-browser wait 1000

  # Wait for dialog to appear
  local dialog_ready=false
  for _i in $(seq 1 10); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Describe your task and instruction"; then
      dialog_ready=true
      break
    fi
    sleep 1
  done
  step_screenshot "add-schedule-dialog"
  assert [ "$dialog_ready" = "true" ]

  # Fill the prompt textarea
  echo "# Filling schedule prompt: $SCHEDULE_PROMPT" >&3
  agent-browser find placeholder "Describe your task and instruction" fill "$SCHEDULE_PROMPT"
  agent-browser wait 500
  step_screenshot "schedule-form-filled"

  # Click Create button
  echo "# Clicking Create..." >&3
  agent-browser find text "Create" click

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

  local prompt_found=false
  for _i in $(seq 1 20); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "$SCHEDULE_PROMPT"; then
      prompt_found=true
      break
    fi
    sleep 1
  done
  step_screenshot "detail-page"

  assert [ "$prompt_found" = "true" ]
  echo "# Schedule prompt verified on detail page!" >&3
}

@test "edit description field and verify save" {
  echo "# Editing description field..." >&3

  # Fill the description input
  agent-browser find placeholder "Leave blank to auto-generate" fill "E2E test description"
  agent-browser wait 1000

  # Wait for the unsaved changes bar (Save button) to appear
  local save_visible=false
  for _i in $(seq 1 10); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Save"; then
      save_visible=true
      break
    fi
    sleep 1
  done
  step_screenshot "unsaved-changes"
  assert [ "$save_visible" = "true" ]

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
  local page_loaded=false
  for _i in $(seq 1 20); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Scheduled tasks"; then
      page_loaded=true
      break
    fi
    sleep 1
  done
  assert [ "$page_loaded" = "true" ]

  # Click Calendar tab
  echo "# Switching to Calendar view..." >&3
  agent-browser find text "Calendar" click
  agent-browser wait 2000

  # Wait for calendar to render
  local calendar_loaded=false
  for _i in $(seq 1 15); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Week view"; then
      calendar_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "calendar-view"
  assert [ "$calendar_loaded" = "true" ]

  # Verify schedule appears in calendar
  local schedule_in_calendar=false
  for _i in $(seq 1 10); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "$SCHEDULE_PROMPT"; then
      schedule_in_calendar=true
      break
    fi
    sleep 1
  done
  step_screenshot "calendar-with-schedule"

  assert [ "$schedule_in_calendar" = "true" ]
  echo "# Schedule verified in calendar view!" >&3
}
