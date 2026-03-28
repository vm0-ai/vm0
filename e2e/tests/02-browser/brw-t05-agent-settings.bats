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
  wait_for_text "$tab_text" 30
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
  # Reuse the browser session from test 1 (sign in via token on platform app).
  # sign_in_via_token_on_app already restarts the daemon and creates a fresh
  # session, so no additional restart or sign-in is needed here. Skipping the
  # redundant restart+sign-in saves ~35s of the 180s BATS budget.
  echo "# Navigating to team page..." >&3
  navigate_to_app_page "/team"
  wait_for_text_gone "Loading your workspace" 20 || true

  # Wait for Lead badge with reload-based retry (same pattern as brw-t03).
  # Fresh sign-in workspace initialization can take >20s under parallel CI load.
  local lead_found=false
  for _attempt in 1 2; do
    if wait_for_text "Lead" 25; then
      lead_found=true
      break
    fi
    echo "# Attempt ${_attempt}: Lead not found, reloading /team..." >&3
    navigate_to_app_page "/team"
    wait_for_text_gone "Loading your workspace" 15 || true
  done
  if [[ "$lead_found" != "true" ]]; then
    echo "# Lead badge not found after 3 attempts" >&3
    return 1
  fi
  step_screenshot "team-page"

  # Wait for Create teammate button to render (may appear disabled initially).
  echo "# Waiting for Create teammate button to appear..." >&3
  if ! wait_for_text "Create teammate" 60; then
    echo "# Create teammate button never appeared after 60s" >&3
    return 1
  fi

  # Pause to let the agents list load (zeroSubagents$ async data fetch).
  # The button renders as disabled while agents haven't loaded; after the list
  # returns, it becomes enabled. 15s is usually sufficient for the API to respond.
  sleep 15

  # Click — retry up to 10 times in case the button is still briefly disabled.
  # Each Playwright auto-wait attempt is ~4s, so 10 retries = up to ~50s budget.
  echo "# Clicking Create teammate..." >&3
  local btn_clicked=false
  for _i in $(seq 1 10); do
    if agent-browser find role button click --name "Create teammate" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 2
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
  # Take screenshot first to let React settle after fill before snapshotting
  # (same pattern as brw-t03 which uses the same dialog and is reliable).
  step_screenshot "create-dialog-filled"

  # Click the Create button in the dialog using --exact to avoid partial-matching
  # the background "Create teammate" button (which would dismiss the modal).
  echo "# Clicking Create button in dialog..." >&3
  agent-browser find role button click --name "Create" --exact

  # Wait for dialog to close, then navigate to /team to verify the agent.
  # Creation may redirect to agent settings; empty snapshots (daemon crash)
  # can falsely pass wait_for_text_gone. Explicit /team navigation is reliable.
  wait_for_text_gone "Create a new teammate" 60
  navigate_to_app_page "/team"
  wait_for_text "$AGENT_NAME" 90
  step_screenshot "agent-created"
  echo "# Agent created: $AGENT_NAME" >&3
}

@test "navigate to agent settings and verify tabs" {
  # Reuse the browser session from test 9 (daemon is still running, session
  # is authenticated). Restarting daemon + sign-in here would consume ~40s of
  # the 180s BATS timeout before we even reach the agent settings page.
  # Test 9 ends with the browser on /team with the agent visible, so a simple
  # navigate_to_app_page is sufficient.
  echo "# Navigating to agent settings for: $AGENT_NAME..." >&3

  # The agent name may appear in a toast before the team list refreshes.
  # Navigate with reload-based retry until the agent CARD is clickable.
  local agent_clicked=false
  for _attempt in 1 2 3; do
    navigate_to_app_page "/team"
    wait_for_text_gone "Loading your workspace" 15 || true
    if ! wait_for_text "$AGENT_NAME" 25; then
      echo "# Attempt ${_attempt}: agent not visible yet, retrying..." >&3
      continue
    fi
    step_screenshot "team-page"
    # Try role link first (precise), then text fallback
    if agent-browser find role link click --name "$AGENT_NAME" 2>/dev/null; then
      agent_clicked=true
      break
    fi
    if agent-browser find text "$AGENT_NAME" click 2>/dev/null; then
      agent_clicked=true
      break
    fi
    echo "# Attempt ${_attempt}: agent visible but not yet clickable, retrying..." >&3
  done
  if [[ "$agent_clicked" != "true" ]]; then
    echo "# Could not click agent card after 3 attempts" >&3
    return 1
  fi
  sleep 2

  # Save URL immediately — before waiting for content, so tests 11-13 can
  # navigate back here even if this test hits its time limit.
  AGENT_SETTINGS_URL=$(agent-browser get url 2>/dev/null || true)
  export AGENT_SETTINGS_URL
  echo "# Agent settings URL captured: $AGENT_SETTINGS_URL" >&3
  step_screenshot "agent-detail"

  # Wait for Connectors tab content — "Add connector" implies the full page
  # loaded (tab labels + default Connectors tab content). No separate
  # "wait for Connectors" label needed; waiting for "Add connector" is enough.
  wait_for_text "Add connector" 60
  echo "# Agent settings page loaded with all tabs" >&3
}

@test "connector: add firecrawl via dialog" {
  # Restart daemon to ensure clean state — test 10 may have left the daemon
  # in an unresponsive state after navigating around the settings page.
  # A fresh daemon + sign-in guarantees tests 11-13 start from a stable baseline.
  echo "# Testing connector: add Firecrawl..." >&3
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app
  wait_for_text_gone "Loading your workspace" 30 || true

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

  # Wait for add connector dialog — can take >15s under parallel CI load
  wait_for_text "Add connector to" 30
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
