#!/usr/bin/env bats
# brw-t03-team.bats — Team page and agent creation tests
#
# Runs in parallel with brw-t04-schedule.bats and brw-t05-agent-settings.bats
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

  AGENT_NAME="E2E-Team-$(date +%s)-$RANDOM"
  export AGENT_NAME

  echo "# Team E2E tests (token auth)" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3
  echo "#   Agent name: $AGENT_NAME" >&3
}

teardown_file() {
  # Clean up the created agent to prevent orphan accumulation
  if [[ -n "${AGENT_NAME:-}" ]]; then
    $ZERO_CLI agent delete "$AGENT_NAME" --yes 2>/dev/null || true
  fi

  browser_teardown
}

@test "sign in via token" {
  sign_in_via_token_on_app
}

@test "navigate to team page and verify lead agent" {
  echo "# Navigating to /team page..." >&3
  navigate_to_app_page "/team"
  step_screenshot "team-page-initial"

  # Wait for Lead badge — workspace setup may still be in progress after onboarding.
  # Retry with page reload in case of stale cache or slow workspace initialization.
  echo "# Waiting for Lead agent badge..." >&3
  local lead_found=false
  for _attempt in 1 2 3; do
    if wait_for_text "Lead" 30; then
      lead_found=true
      break
    fi
    echo "# Attempt ${_attempt}: Lead not found, reloading /team..." >&3
    navigate_to_app_page "/team"
  done
  assert [ "$lead_found" = "true" ]
  step_screenshot "team-page-loaded"

  local snap
  snap=$(full_snapshot)

  # Verify Create teammate button via interactive snapshot (the button has
  # composite content with an icon, so it does not appear in the text snapshot
  # used by wait_for_text — use the interactive snapshot instead).
  echo "# Verifying Create teammate button..." >&3
  local btn_found=false
  for _i in $(seq 1 30); do
    local snap_i
    snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
    if echo "$snap_i" | grep -qi 'Create teammate'; then
      btn_found=true
      break
    fi
    sleep 1
  done
  assert [ "$btn_found" = "true" ]

  echo "# Team page verified!" >&3
}

@test "create new agent via dialog" {
  # Retry clicking Create teammate — use role-based find which works more
  # reliably than text-based find for buttons with composite content
  echo "# Clicking Create teammate (with retry)..." >&3
  local btn_clicked=false
  for _i in $(seq 1 30); do
    if agent-browser find role button click --name "Create teammate" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  assert [ "$btn_clicked" = "true" ]
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

  # Wait for dialog to close, then immediately verify agent appears.
  # Keep both waits in the same test — splitting across tests causes the
  # agent name to be missed when the browser navigates post-creation.
  wait_for_text_gone "Create a new teammate" 30
  wait_for_text "$AGENT_NAME" 40
  step_screenshot "after-create"
  echo "# Agent created!" >&3
}

@test "verify new agent appears on team page" {
  # After creation the app may navigate to the agent settings page or show a
  # toast that disappears. Navigate explicitly to /team to get a stable list.
  echo "# Verifying agent appears on team page..." >&3
  local agent_found=false
  for _attempt in 1 2 3; do
    navigate_to_app_page "/team"
    if wait_for_text "$AGENT_NAME" 20; then
      agent_found=true
      break
    fi
    echo "# Attempt ${_attempt}: agent not found on /team, retrying..." >&3
  done
  assert [ "$agent_found" = "true" ]
  step_screenshot "agent-visible"

  # wait_for_text already verified the agent name is visible; no need for a
  # second snapshot here since the agent name may appear in a toast that
  # disappears before a fresh full_snapshot completes.

  local final_url
  final_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Final URL: $final_url" >&3
  step_screenshot "team-page-final"

  echo "# New agent verified on team page!" >&3
}
