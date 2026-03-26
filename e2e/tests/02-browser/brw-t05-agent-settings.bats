#!/usr/bin/env bats
# brw-t05-agent-settings.bats — Verify agent settings editing (connector, profile, instructions)
#
# Tests the agent settings pages: navigates to the default agent's settings,
# adds a Firecrawl connector, edits the profile description, and edits
# instructions. Each edit verifies the unsaved bar appears and that saving
# succeeds (unsaved bar disappears).
#
# Required env vars:
#   VM0_API_URL        — Target web app URL (e.g., https://www.vm7.ai:8443)
#   CLERK_SECRET_KEY   — Clerk Backend API key (for creating sign-in tokens)

load '../../helpers/setup'
load '../../helpers/browser'

# ---------------------------------------------------------------------------
# wait_for_unsaved_bar — Poll until "unsaved changes" text appears
# ---------------------------------------------------------------------------
wait_for_unsaved_bar() {
  local timeout_secs="${1:-15}"
  if ! wait_for_text "unsaved changes" "$timeout_secs"; then
    echo "# Timed out waiting for unsaved bar to appear" >&3
    return 1
  fi
}

# ---------------------------------------------------------------------------
# wait_for_no_unsaved_bar — Poll until "unsaved changes" text disappears
# ---------------------------------------------------------------------------
wait_for_no_unsaved_bar() {
  local timeout_secs="${1:-20}"
  if ! wait_for_text_gone "unsaved changes" "$timeout_secs"; then
    echo "# Timed out waiting for unsaved bar to disappear" >&3
    return 1
  fi
}

# ---------------------------------------------------------------------------
# click_save_on_unsaved_bar — Click the Save button on the unsaved bar
# Uses interactive snapshot to find the correct Save button ref
# ---------------------------------------------------------------------------
click_save_on_unsaved_bar() {
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  # Find Save button near "unsaved changes" context
  ref=$(echo "$snap_i" | grep -A5 -i "unsaved changes" | grep -oE '\[ref=e[0-9]+\]' | tail -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$ref" ]]; then
    echo "# Failed to find Save button ref near unsaved changes bar" >&3
    return 1
  fi
  agent-browser click "$ref"
}

setup_file() {
  browser_setup
  create_clerk_sign_in_token

  APP_URL="$(derive_app_url)"
  export APP_URL

  echo "# Agent settings editing flow via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
}

teardown_file() {
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

@test "navigate to team page and open agent settings" {
  echo "# Navigating to team page..." >&3
  agent-browser open "${APP_URL}/team" --ignore-https-errors
  agent-browser wait 3000

  # Wait for team page to load
  local page_loaded=false
  for _i in $(seq 1 20); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Lead"; then
      page_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "team-page"
  assert [ "$page_loaded" = "true" ]

  # Click on the default agent card (has "Lead" badge)
  echo "# Clicking on default agent card..." >&3
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  # Find the card link that contains the "Lead" badge text
  ref=$(echo "$snap_i" | grep -i "Lead" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$ref" ]]; then
    echo "# Failed to find Lead agent card ref" >&3
    return 1
  fi
  agent-browser click "$ref"
  agent-browser wait 3000

  # Wait for agent detail page to load with tabs
  local detail_loaded=false
  for _i in $(seq 1 20); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Connectors"; then
      detail_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "agent-detail"
  assert [ "$detail_loaded" = "true" ]

  # Verify all tabs are visible
  local snap
  snap=$(full_snapshot)
  contains "$snap" "Connectors"
  contains "$snap" "Profile"
  contains "$snap" "Instructions"
  echo "# Agent settings page loaded with all tabs" >&3
}

@test "connector: add firecrawl and save" {
  # Ensure we are on the Connectors tab
  echo "# Testing connector: add Firecrawl..." >&3
  agent-browser find text "Connectors" click
  agent-browser wait 1000
  step_screenshot "connector-before"

  # Click "Add connector"
  agent-browser find text "Add connector" click
  agent-browser wait 2000

  # Wait for add connector dialog
  wait_for_text "Add connector to" 15
  step_screenshot "connector-dialog"

  # Search for Firecrawl
  agent-browser find placeholder "Search..." fill "Firecrawl"
  agent-browser wait 1000

  # Wait for and click Firecrawl
  wait_for_text "Firecrawl" 10
  agent-browser find text "Firecrawl" click
  agent-browser wait 2000

  # Wait for API token modal
  wait_for_text "API Token" 10
  step_screenshot "connector-firecrawl-modal"

  # Fill in API token
  agent-browser find placeholder "fc-xxxxxxxx" fill "fc-e2etest12345"
  agent-browser wait 500

  # Click Save in the modal
  agent-browser find text "Save" click
  agent-browser wait 3000
  step_screenshot "connector-after-modal-save"

  # Wait for unsaved bar to appear (connector added to list)
  wait_for_unsaved_bar 15
  step_screenshot "connector-unsaved"

  # Click Save on the unsaved bar
  click_save_on_unsaved_bar
  agent-browser wait 2000

  # Wait for unsaved bar to disappear
  wait_for_no_unsaved_bar 20
  step_screenshot "connector-saved"

  echo "# Connector save complete!" >&3
}

@test "profile: edit description and save" {
  echo "# Testing profile: edit description..." >&3
  agent-browser find text "Profile" click
  agent-browser wait 2000

  # Wait for profile form to load
  wait_for_text "Description" 15
  step_screenshot "profile-before"

  # Fill description with timestamped value
  local test_value="E2E test description $(date +%s)"
  agent-browser find placeholder "What does this agent do?" fill "$test_value"
  agent-browser wait 1000

  # Wait for unsaved bar
  wait_for_unsaved_bar 15
  step_screenshot "profile-unsaved"

  # Click Save on unsaved bar
  click_save_on_unsaved_bar
  agent-browser wait 2000

  # Wait for unsaved bar to disappear
  wait_for_no_unsaved_bar 20
  step_screenshot "profile-saved"

  # Verify the value persisted
  local snap
  snap=$(full_snapshot)
  contains "$snap" "E2E test description"

  echo "# Profile save complete!" >&3
}

@test "instructions: edit and save" {
  echo "# Testing instructions: edit text..." >&3
  agent-browser find text "Instructions" click
  agent-browser wait 2000

  # Wait for instructions editor to load
  local editor_loaded=false
  for _i in $(seq 1 15); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Write instructions for your agent"; then
      editor_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "instructions-before"
  assert [ "$editor_loaded" = "true" ]

  # Click on the editor area to focus it using interactive snapshot
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  ref=$(echo "$snap_i" | grep -i "contenteditable\|tiptap\|ProseMirror\|Write instructions" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$ref" ]]; then
    echo "# Failed to find instructions editor element ref" >&3
    return 1
  fi
  agent-browser click "$ref"
  agent-browser wait 500

  # Type test content
  local test_chars="E2E test instructions"
  for char in $(echo "$test_chars" | grep -o .); do
    if [[ "$char" == " " ]]; then
      agent-browser press "Space"
    else
      agent-browser press "$char"
    fi
  done
  agent-browser wait 1000

  # Wait for unsaved bar
  wait_for_unsaved_bar 15
  step_screenshot "instructions-unsaved"

  # Click Save on unsaved bar
  click_save_on_unsaved_bar
  agent-browser wait 3000

  # Wait for unsaved bar to disappear (instructions may take longer due to build)
  wait_for_no_unsaved_bar 30
  step_screenshot "instructions-saved"

  echo "# Instructions save complete!" >&3
}
