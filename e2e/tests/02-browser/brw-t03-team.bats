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

  # Wait for Lead badge — workspace setup may still be in progress after onboarding
  echo "# Waiting for Lead agent badge..." >&3
  wait_for_text "Lead" 40
  step_screenshot "team-page-loaded"

  local snap
  snap=$(full_snapshot)

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
