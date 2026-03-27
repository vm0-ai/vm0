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
# Tries role-based find first (most reliable), then falls back to interactive
# snapshot parsing which can have quote/format variations across environments.
# ---------------------------------------------------------------------------
click_tab() {
  local tab_text="$1"
  wait_for_text "$tab_text" 10
  # Try role-based find first — avoids snapshot quote/format brittle matching
  if agent-browser find role tab click --name "$tab_text" 2>/dev/null; then
    return 0
  fi
  # Fallback: parse interactive snapshot with flexible matching
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  ref=$(echo "$snap_i" | grep -iE "tab.*\"${tab_text}\"" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -z "$ref" ]]; then
    echo "# Failed to find tab ref for '${tab_text}'" >&3
    return 1
  fi
  agent-browser click "$ref"
}

setup_file() {
  # Stagger startup so sign-in tokens are not created simultaneously for the
  # same Clerk account across parallel workers (which would invalidate earlier tokens).
  stagger_parallel

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
  # The sign-in navigation can leave the daemon unresponsive. Fully restart the
  # daemon (kill process + remove socket) to guarantee a clean state.
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app

  echo "# Navigating to team page..." >&3
  agent-browser open "${APP_URL}/team" --ignore-https-errors
  sleep 3

  # Wait for team page to load (org redirect can take a while in CI)
  wait_for_text "Lead" 40
  step_screenshot "team-page"

  # Wait for any global loading overlay to clear before clicking (overlay
  # blocks clicks even when the button is found via accessibility).
  wait_for_text_gone "Loading your workspace" 30 || true

  # Click Create teammate — use role-based find which works more reliably
  # than text-based find for buttons with composite content
  echo "# Clicking Create teammate..." >&3
  local btn_clicked=false
  for _i in $(seq 1 30); do
    if agent-browser find role button click --name "Create teammate" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  if [[ "$btn_clicked" != "true" ]]; then
    echo "# Failed to click Create teammate button" >&3
    return 1
  fi
  sleep 1

  # Wait for dialog (allow extra time since parallel CI load can slow rendering)
  wait_for_text "Create a new teammate" 30
  step_screenshot "create-dialog"

  # Fill agent name
  echo "# Filling agent name: $AGENT_NAME" >&3
  agent-browser find placeholder "e.g. Research Assistant" fill "$AGENT_NAME"
  sleep 0.5

  # Click Create button in dialog
  local snap_i create_ref
  snap_i=$(agent-browser snapshot -i)
  create_ref=$(echo "$snap_i" | grep -E 'button "Create"' | grep -v 'teammate' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$create_ref" ]]; then
    agent-browser click "$create_ref"
  else
    echo "# Create button ref not found in snapshot, trying role-based click..." >&3
    agent-browser find role button click --name "Create"
  fi

  # Wait for dialog to close, then navigate to /team to verify the agent.
  # Creation may redirect to agent settings; empty snapshots (daemon crash)
  # can falsely pass wait_for_text_gone. Explicit /team navigation is reliable.
  wait_for_text_gone "Create a new teammate" 30
  navigate_to_app_page "/team"
  wait_for_text "$AGENT_NAME" 60
  step_screenshot "agent-created"
  echo "# Agent created: $AGENT_NAME" >&3
}

@test "navigate to agent settings and verify tabs" {
  # The agent creation test can run for 60-90 seconds. Fully restart the daemon
  # (kill process + remove socket) to recover from any unresponsive state.
  # Create a fresh sign-in token — the one created in setup_file was consumed
  # by the earlier "sign in via token on platform app" test and cannot be reused.
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app

  echo "# Navigating to team page..." >&3
  navigate_to_app_page "/team"
  # Wait for any global loading overlay to clear before checking for agent name.
  wait_for_text_gone "Loading your workspace" 30 || true
  wait_for_text "$AGENT_NAME" 40
  step_screenshot "team-page"

  # Click on the created agent card — retry waiting for the card to appear
  # in the interactive snapshot (the name may appear briefly in a toast
  # before the card is rendered, so we can't just wait_for_text once)
  echo "# Waiting for agent card to be clickable: $AGENT_NAME..." >&3
  local agent_clicked=false
  for _i in $(seq 1 30); do
    local snap_i agent_ref
    snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
    agent_ref=$(echo "$snap_i" | grep -F "$AGENT_NAME" | grep -v 'textbox\|disabled' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    if [[ -n "$agent_ref" ]]; then
      agent-browser scrollintoview "$agent_ref" 2>/dev/null || true
      sleep 0.3
      if agent-browser click "$agent_ref" 2>/dev/null; then
        agent_clicked=true
        break
      fi
    fi
    sleep 1
  done
  if [[ "$agent_clicked" != "true" ]]; then
    echo "# Ref-based click failed, trying role-based find..." >&3
    agent-browser find role link click --name "$AGENT_NAME" 2>/dev/null || \
      agent-browser find text "$AGENT_NAME" click
  fi
  sleep 3

  # Wait for agent detail page to load with tabs
  wait_for_text "Connectors" 40
  step_screenshot "agent-detail"

  # Verify all tabs are visible (non-default agent shows all tabs).
  # Use wait_for_text instead of a single full_snapshot to handle transient
  # re-renders between the wait_for_text above and the assertions below.
  wait_for_text "Profile" 10
  wait_for_text "Instructions" 10

  # Save the URL now so subsequent tests can navigate back even if this test
  # fails on the Add connector wait (prevents cascading failures).
  AGENT_SETTINGS_URL=$(agent-browser get url 2>/dev/null || true)
  export AGENT_SETTINGS_URL
  echo "# Agent settings URL captured: $AGENT_SETTINGS_URL" >&3

  # Wait for Connectors tab content to fully load (the "Add connector" button
  # loads async after the tab labels appear).
  if ! wait_for_text "Add connector" 90; then
    echo "# Add connector not found after 90s, reloading page..." >&3
    if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
      agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
      sleep 5
    fi
    wait_for_text "Add connector" 60
  fi
  echo "# Agent settings page loaded with all tabs" >&3
}

@test "connector: add firecrawl via dialog" {
  # Connectors tab is already selected by default after navigating to agent settings.
  # Navigate back to ensure we start from a clean page state.
  echo "# Testing connector: add Firecrawl..." >&3
  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
    sleep 3
  fi
  # Wait for agent settings page to fully load (tab labels + Connectors content)
  wait_for_text "Connectors" 30
  wait_for_text "Add connector" 30
  step_screenshot "connector-before"

  # Click "Add connector"
  agent-browser find text "Add connector" click
  sleep 2

  # Wait for add connector dialog
  wait_for_text "Add connector to" 15
  step_screenshot "connector-dialog"

  # Search for Firecrawl
  agent-browser find placeholder "Search..." fill "Firecrawl"
  sleep 1

  # Wait for and click Firecrawl
  wait_for_text "Firecrawl" 10
  agent-browser find text "Firecrawl" click
  sleep 2

  # Wait for API token modal
  wait_for_text "API Token" 10
  step_screenshot "connector-firecrawl-modal"

  # Fill in API token
  agent-browser find placeholder "fc-xxxxxxxx" fill "fc-e2etest12345"
  sleep 0.5

  # Click Save in the API token modal
  agent-browser find text "Save" click
  sleep 3
  step_screenshot "connector-after-modal-save"

  # Close the Add Connector dialog
  local snap_i close_ref
  snap_i=$(agent-browser snapshot -i)
  close_ref=$(echo "$snap_i" | grep -E '^- button "Close"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$close_ref" ]]; then
    echo "# Closing add connector dialog..." >&3
    agent-browser click "$close_ref"
    sleep 1
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
    sleep 1
  fi
  wait_for_no_unsaved_bar 10 || true

  echo "# Connector dialog flow complete!" >&3
}

@test "profile: edit description and save" {
  echo "# Testing profile: edit description..." >&3
  # Navigate back to agent settings to ensure page is in known state
  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
    sleep 3
  fi
  # Wait for agent settings page to fully load before clicking tab
  wait_for_text "Connectors" 30
  click_tab "Profile"
  sleep 2

  # Wait for profile form to load. The form content (Description field and
  # its placeholder) loads async after the tab switch. Retry tab click if
  # the content does not appear in time.
  if ! wait_for_text "Description" 15; then
    echo "# Profile content not loaded, retrying tab click..." >&3
    click_tab "Profile"
    sleep 2
    wait_for_text "Description" 30
  fi
  wait_for_text "What does this agent do" 30
  step_screenshot "profile-before"

  # Fill description with timestamped value
  local test_value="E2E test description $(date +%s)"
  agent-browser find placeholder "What does this agent do?" fill "$test_value"
  sleep 1

  # Wait for unsaved bar
  wait_for_unsaved_bar 15
  step_screenshot "profile-unsaved"

  # Click Save on unsaved bar
  click_save_on_unsaved_bar
  sleep 2

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
  # Navigate back to agent settings to ensure page is in known state
  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
    sleep 3
  fi
  # Wait for agent settings page to fully load before clicking tab.
  # Retry with a reload in case prior test left the daemon in a bad state.
  if ! wait_for_text "Connectors" 30; then
    echo "# Connectors not found, reloading agent settings page..." >&3
    if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
      agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
      sleep 5
    fi
    wait_for_text "Connectors" 30
  fi
  click_tab "Instructions"
  sleep 2

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
  sleep 1

  # Wait for unsaved bar
  wait_for_unsaved_bar 15
  step_screenshot "instructions-unsaved"

  # Click Save on unsaved bar
  click_save_on_unsaved_bar
  sleep 3

  # Wait for unsaved bar to disappear (instructions may take longer due to build)
  wait_for_no_unsaved_bar 30
  step_screenshot "instructions-saved"

  echo "# Instructions save complete!" >&3
}
