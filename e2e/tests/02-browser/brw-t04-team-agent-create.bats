#!/usr/bin/env bats
# brw-t04-team-agent-create.bats — Verify team page agent listing and creation
#
# Tests: navigate to /team → verify zero agent → create new agent → verify it appears
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

  echo "# Team page agent creation flow via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Agent name: $AGENT_NAME" >&3
}

teardown_file() {
  # Clean up the created agent to prevent orphan accumulation
  if [[ -n "${AGENT_NAME:-}" ]]; then
    $ZERO_CLI agent delete "$AGENT_NAME" --yes 2>/dev/null || true
  fi

  browser_teardown
}

@test "sign in via token on platform app" {
  echo "# Signing in via token on platform app..." >&3
  agent-browser open "${APP_URL}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  agent-browser wait 5000
  step_screenshot "sign-in-token"

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

  dismiss_cookie_banner
}

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
