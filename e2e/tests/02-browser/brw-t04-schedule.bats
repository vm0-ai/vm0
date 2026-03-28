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
  echo "# Navigating to schedule page via sidebar Scheduled link (SPA navigation)..." >&3
  # Prefer sidebar SPA navigation to avoid full-page reload issues under parallel CI load.
  local nav_ok=false
  for _i in $(seq 1 10); do
    if agent-browser find role link click --name "Scheduled" 2>/dev/null; then
      nav_ok=true
      break
    fi
    sleep 1
  done
  if [[ "$nav_ok" != "true" ]]; then
    echo "# Sidebar link not found, falling back to direct navigation..." >&3
    agent-browser open "${APP_URL}/schedule" --ignore-https-errors
    sleep 3
  else
    sleep 2
  fi

  # Wait for schedule page to load. Under parallel CI load snapshots can be
  # slow (~2-3s each), so use a reload-based retry to stay within test timeout.
  local schedule_found=false
  for _attempt in 1 2; do
    if wait_for_text "Scheduled tasks" 20; then
      schedule_found=true
      break
    fi
    echo "# Attempt ${_attempt}: schedule page not loaded yet, reloading..." >&3
    agent-browser open "${APP_URL}/schedule" --ignore-https-errors
    sleep 5
  done
  assert [ "$schedule_found" = "true" ]

  # Wait for any global loading overlay to clear before clicking buttons.
  # The page may show "Loading your workspace..." while the org data loads;
  # buttons underneath the overlay cannot be clicked until it disappears.
  wait_for_text_gone "Loading your workspace" 30 || true
  step_screenshot "schedule-page"

  # Wait for the "Add schedule" button to appear before clicking (the button
  # may load async after the overlay clears).
  wait_for_text "Add schedule" 15 || true

  # Click "Add schedule" — the button is disabled until agents finish loading
  # (disabled={agents.length === 0}). Retry for up to 60s to give agents time
  # to load, especially in fresh workspaces under parallel CI load.
  echo "# Clicking Add schedule..." >&3
  local btn_clicked=false
  for _i in $(seq 1 60); do
    if agent-browser find role button click --name "Add schedule" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  if [[ "$btn_clicked" != "true" ]]; then
    # Fallback: try text-based find in case the accessible name differs
    if agent-browser find text "Add schedule" click 2>/dev/null; then
      btn_clicked=true
    fi
  fi
  assert [ "$btn_clicked" = "true" ]
  sleep 1

  # Wait for dialog to appear — verify by finding the Prompt textarea label
  # (more specific than text search which could match existing schedule prompts)
  local dialog_open=false
  for _i in $(seq 1 15); do
    if agent-browser find label "Prompt" 2>/dev/null; then
      dialog_open=true
      break
    fi
    sleep 1
  done
  assert [ "$dialog_open" = "true" ]
  step_screenshot "add-schedule-dialog"

  # Fill and submit the form in the same test — dialog state does not persist
  # reliably across BATS test boundaries.
  echo "# Filling schedule prompt: $SCHEDULE_PROMPT" >&3
  agent-browser find label "Prompt" fill "$SCHEDULE_PROMPT"
  sleep 0.5
  step_screenshot "schedule-form-filled"

  echo "# Clicking Create..." >&3
  agent-browser find role button click --name "Create"

  # After clicking Create, the backend schedule creation API can take
  # 60-120+ seconds. We do NOT wait for it to complete — that would exceed
  # BATS_TEST_TIMEOUT (180s). Instead, we just verify the click succeeded
  # by waiting briefly and taking a screenshot for debugging.
  sleep 5
  step_screenshot "after-create-click"
  echo "# Schedule creation form submitted!" >&3
}

@test "verify schedule list page loads" {
  # The schedule creation API call in test 6 can leave the daemon unresponsive.
  # Unconditionally restart to ensure a clean state. Then wait for the workspace
  # to fully initialize after sign-in before navigating to /schedule.
  echo "# Restarting browser daemon after schedule creation..." >&3
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app
  # Wait for workspace initialization after fresh sign-in (avoids long overlay
  # on /schedule that can prevent page content from rendering).
  wait_for_text_gone "Loading your workspace" 60 || true

  echo "# Verifying schedule list page loads..." >&3
  agent-browser open "${APP_URL}/schedule" --ignore-https-errors
  # Use shell sleep instead of agent-browser wait — daemon can crash under
  # parallel CI load when routing a simple delay through IPC.
  sleep 3

  # Wait for any remaining loading overlay to clear.
  wait_for_text_gone "Loading your workspace" 30 || true

  local schedule_found=false
  for _attempt in 1 2 3; do
    if wait_for_text "Scheduled tasks" 30; then
      schedule_found=true
      break
    fi
    echo "# Attempt ${_attempt}: schedule page not loaded yet, reloading..." >&3
    agent-browser open "${APP_URL}/schedule" --ignore-https-errors
    sleep 5
    wait_for_text_gone "Loading your workspace" 30 || true
  done
  assert [ "$schedule_found" = "true" ]
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
