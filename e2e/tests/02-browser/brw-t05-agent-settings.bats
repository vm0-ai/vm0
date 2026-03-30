#!/usr/bin/env bats
# brw-t05-agent-settings.bats — Verify agent settings editing (connector, profile, instructions)
#
# Tests the agent settings pages: creates a new agent, navigates to its settings,
# adds a Firecrawl connector, edits the profile description, and edits
# instructions. Each edit verifies the unsaved bar appears and that saving
# succeeds (unsaved bar disappears).
#
# Note: Uses a newly-created agent (not the default "Lead" agent) because
# non-admin users cannot access Profile/Instructions tabs on the default agent.
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
# The unsaved bar's Save button appears as a top-level button in the
# interactive snapshot (outside the main page element).
# ---------------------------------------------------------------------------
click_save_on_unsaved_bar() {
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  # The unsaved bar Save button is a top-level button "Save" (not nested inside
  # the main page generic element). Match the first top-level Save button.
  ref=$(echo "$snap_i" | grep -E '^- button "Save"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$ref" ]]; then
    # Fallback: look for any Save button (may be slightly indented)
    ref=$(echo "$snap_i" | grep -E 'button "Save"' | grep -oE '\[ref=e[0-9]+\]' | tail -1 | sed 's/\[ref=/@/; s/\]//')
  fi
  if [[ -z "$ref" ]]; then
    echo "# Failed to find Save button ref on unsaved bar" >&3
    return 1
  fi
  agent-browser click "$ref"
}

# ---------------------------------------------------------------------------
# click_tab — Click a tab by its text label
# Uses interactive snapshot to find the tab ref, since agent-browser find text
# does not match tab role elements.
# ---------------------------------------------------------------------------
click_tab() {
  local tab_text="$1"
  wait_for_text "$tab_text" 10
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  ref=$(echo "$snap_i" | grep -E "tab \"${tab_text}\"" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$ref" ]]; then
    echo "# Failed to find tab ref for '${tab_text}'" >&3
    return 1
  fi
  agent-browser click "$ref"
}

setup_file() {
  browser_setup
  create_clerk_sign_in_token

  APP_URL="$(derive_app_url)"
  export APP_URL

  AGENT_NAME="E2E-Settings-$(date +%s)-$RANDOM"
  export AGENT_NAME

  echo "# Agent settings editing flow via agent-browser" >&3
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
  sign_in_via_token_on_app
}

@test "create agent for settings testing" {
  echo "# Navigating to team page..." >&3
  agent-browser open "${APP_URL}/team" --ignore-https-errors
  agent-browser wait 3000

  # Wait for team page to load (org redirect can take a while in CI)
  wait_for_text "Lead" 40
  step_screenshot "team-page"

  # Click Create teammate
  echo "# Clicking Create teammate..." >&3
  agent-browser find text "Create teammate" click
  agent-browser wait 1000

  # Wait for dialog
  wait_for_text "Create a new teammate" 10
  step_screenshot "create-dialog"

  # Fill agent name
  echo "# Filling agent name: $AGENT_NAME" >&3
  agent-browser find placeholder "e.g. Research Assistant" fill "$AGENT_NAME"
  agent-browser wait 500

  # Click Create button in dialog
  local snap_i create_ref
  snap_i=$(agent-browser snapshot -i)
  create_ref=$(echo "$snap_i" | grep -E 'button "Create"' | grep -v 'teammate' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$create_ref" ]]; then
    echo "# Failed to find Create button ref in interactive snapshot" >&3
    return 1
  fi
  agent-browser click "$create_ref"

  # Wait for dialog to close before checking the team page list
  wait_for_text_gone "Create a new teammate" 30
  wait_for_text "$AGENT_NAME" 10
  step_screenshot "agent-created"
  echo "# Agent created: $AGENT_NAME" >&3
}

@test "navigate to agent settings and verify tabs" {
  # Navigate to /team fresh to clear any leftover dialog state from agent creation
  echo "# Navigating to team page..." >&3
  navigate_to_app_page "/team"
  wait_for_text "$AGENT_NAME" 40
  step_screenshot "team-page"

  # Click on the created agent card using link-based approach
  echo "# Clicking on agent card: $AGENT_NAME..." >&3
  local snap_i agent_ref
  snap_i=$(agent-browser snapshot -i)
  # Find a link element (not a textbox) containing the agent name
  agent_ref=$(echo "$snap_i" | grep -F "$AGENT_NAME" | grep -v 'textbox\|disabled' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$agent_ref" ]]; then
    # Fallback: use text-based find which targets visible clickable elements
    echo "# Using text-based find as fallback..." >&3
    agent-browser find text "$AGENT_NAME" click
  else
    agent-browser click "$agent_ref"
  fi
  agent-browser wait 3000

  # Wait for agent detail page to load with tabs
  wait_for_text "Connectors" 20
  step_screenshot "agent-detail"

  # Verify all tabs are visible (non-default agent shows all tabs)
  local snap
  snap=$(full_snapshot)
  contains "$snap" "Connectors"
  contains "$snap" "Profile"
  contains "$snap" "Instructions"
  echo "# Agent settings page loaded with all tabs" >&3
}

@test "connector: add firecrawl via dialog" {
  # Connectors tab is already selected by default after navigating to agent settings
  echo "# Testing connector: add Firecrawl..." >&3
  wait_for_text "Add connector" 10
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

  # Click Save in the API token modal
  agent-browser find text "Save" click
  agent-browser wait 3000
  step_screenshot "connector-after-modal-save"

  # Close the Add Connector dialog
  local snap_i close_ref
  snap_i=$(agent-browser snapshot -i)
  close_ref=$(echo "$snap_i" | grep -E '^- button "Close"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$close_ref" ]]; then
    echo "# Closing add connector dialog..." >&3
    agent-browser click "$close_ref"
    agent-browser wait 1000
  fi

  # Verify the unsaved bar appeared (confirms connector was added to the list)
  wait_for_unsaved_bar 15
  step_screenshot "connector-unsaved"

  # Discard the change to leave a clean state for subsequent tests.
  # The full save-and-dismiss cycle is covered by the profile test below.
  local discard_ref
  snap_i=$(agent-browser snapshot -i)
  discard_ref=$(echo "$snap_i" | grep -E '^- button "Discard"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$discard_ref" ]]; then
    agent-browser click "$discard_ref"
    agent-browser wait 1000
  fi
  wait_for_no_unsaved_bar 10 || true

  echo "# Connector dialog flow complete!" >&3
}

@test "profile: edit description and save" {
  echo "# Testing profile: edit description..." >&3
  click_tab "Profile"
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
  click_tab "Instructions"
  agent-browser wait 2000

  # Wait for instructions editor to load by checking for the footer hint text
  # which is a regular <p> element visible in the accessibility snapshot.
  # The Tiptap placeholder is CSS-only and does not appear in snapshots.
  if ! wait_for_text "Edit the instructions directly" 20; then
    echo "# Instructions editor did not load within 20 seconds" >&3
    step_screenshot "instructions-before"
    return 1
  fi
  step_screenshot "instructions-before"

  # Find the editor via interactive snapshot and fill it using its ref.
  # Keyboard press after CSS click doesn't reliably trigger ProseMirror's
  # change detection. Using fill on the editable ref is more robust.
  local snap_i editor_ref
  snap_i=$(agent-browser snapshot -i)
  editor_ref=$(echo "$snap_i" | grep 'editable.*contenteditable' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$editor_ref" ]]; then
    echo "# Instructions editor ref not found in interactive snapshot" >&3
    step_screenshot "instructions-no-editor"
    return 1
  fi
  agent-browser fill "$editor_ref" "E2E test instructions $(date +%s)"
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
