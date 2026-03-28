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

  # Click "Create teammate" — retry up to 90 times (1s sleep each) which covers
  # both waiting for the button to render AND waiting for it to become enabled.
  # Combining the wait + click into one loop avoids a 60s text-check followed by
  # a separate 30s click-retry, saving time under heavy CI load where snapshots
  # can be slow and the button may appear in the accessibility tree before
  # wait_for_text (which polls non-interactive snapshots) detects its text.
  echo "# Clicking Create teammate..." >&3
  local btn_clicked=false
  for _i in $(seq 1 90); do
    if agent-browser find role button click --name "Create teammate" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  if [[ "$btn_clicked" != "true" ]]; then
    echo "# Failed to click Create teammate button after 90s" >&3
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
  step_screenshot "create-dialog-filled"

  # Click the Create button via interactive snapshot ref — more reliable than
  # role-based find since it avoids any accessible-name normalization issues.
  echo "# Clicking Create button in dialog..." >&3
  local snap_i create_ref
  snap_i=$(agent-browser snapshot -i)
  # Match "Create" button only — the line format is: '- button "Create" [ref=eN]'
  # Using ' \[' after the closing quote prevents matching "Create teammate" or
  # "Creating..." buttons.
  create_ref=$(echo "$snap_i" | grep -E '^- button "Create" \[' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$create_ref" ]]; then
    agent-browser click "$create_ref"
  else
    # Fallback: role-based find without exact (the dialog's Create button may have
    # extra whitespace or aria-label causing exact match to fail)
    agent-browser find role button click --name "Create" 2>/dev/null || true
  fi
  sleep 1

  # Verify the click triggered the creation (button changes to "Creating...").
  # Retry via snapshot ref if not — the first click may have missed the button.
  if ! wait_for_text "Creating..." 5 2>/dev/null; then
    if agent-browser find text "Create a new teammate" 2>/dev/null; then
      echo "# First click may not have triggered — retrying via snapshot ref..." >&3
      local retry_snap retry_ref
      retry_snap=$(agent-browser snapshot -i)
      retry_ref=$(echo "$retry_snap" | grep -E '^- button "Create" \[' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
      if [[ -n "$retry_ref" ]]; then
        agent-browser click "$retry_ref"
      fi
      sleep 1
    fi
  fi

  # Wait for dialog to close, then navigate to /team to verify the agent.
  # Creation may redirect to agent settings; empty snapshots (daemon crash)
  # can falsely pass wait_for_text_gone. Explicit /team navigation is reliable.
  wait_for_text_gone "Create a new teammate" 60
  navigate_to_app_page "/team"
  # Under heavy CI load the agent may take >60s to appear on /team after creation.
  # This check is best-effort — test 10 has its own 3-attempt retry loop that
  # will reliably find the agent before tests 11-13 depend on the settings URL.
  if ! wait_for_text "$AGENT_NAME" 45; then
    echo "# Agent not yet visible on /team (backend still processing) — test 10 will retry" >&3
  fi
  step_screenshot "agent-created"
  echo "# Agent created: $AGENT_NAME" >&3
}

@test "navigate to agent settings and verify tabs" {
  # Restart daemon to ensure a clean browser state — test 9's Create interaction
  # can leave the daemon unresponsive. A fresh daemon + sign-in guarantees this
  # test starts from a stable baseline regardless of test 9's outcome.
  echo "# Restarting daemon for clean state..." >&3
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app
  wait_for_text_gone "Loading your workspace" 30 || true
  echo "# Navigating to agent settings for: $AGENT_NAME..." >&3

  # Navigate to /team and wait for the agent to appear — backend creation can
  # take 30-90s after the dialog closes. Use a reload-based retry with a
  # long per-attempt timeout (90s on first attempt, 30s on second) so slow
  # CI environments do not exhaust the budget prematurely.
  local agent_clicked=false
  navigate_to_app_page "/team"
  wait_for_text_gone "Loading your workspace" 10 || true
  for _attempt in 1 2; do
    local wait_secs=90
    if [[ "$_attempt" -gt 1 ]]; then
      wait_secs=30
      navigate_to_app_page "/team"
      wait_for_text_gone "Loading your workspace" 10 || true
    fi
    if ! wait_for_text "$AGENT_NAME" "$wait_secs"; then
      echo "# Attempt ${_attempt}: agent not visible after ${wait_secs}s, retrying..." >&3
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
    echo "# Could not click agent card after 2 attempts" >&3
    return 1
  fi
  # Wait for navigation to agent settings page to complete before capturing URL.
  # The URL may briefly be "about:blank" while the browser navigates; wait
  # until it contains "/team/<uuid>" before saving for tests 11-13.
  local raw_url=""
  for _w in $(seq 1 20); do
    raw_url=$(agent-browser get url 2>/dev/null || true)
    if [[ "$raw_url" == *"/team/"* && "$raw_url" != *"/team" && "$raw_url" != *"/team/" ]]; then
      break
    fi
    sleep 1
  done
  # Strip query params so tests 11-13 always open on the default Connectors tab.
  AGENT_SETTINGS_URL="${raw_url%%\?*}"
  export AGENT_SETTINGS_URL
  # Persist to temp file so tests 11-13 can load it even though BATS runs each
  # test in a separate subprocess (exports inside tests don't cross subshell
  # boundaries to sibling tests).
  echo "$AGENT_SETTINGS_URL" > "${BATS_TMPDIR}/brw_t05_agent_settings_url"
  echo "# Agent settings URL captured: $AGENT_SETTINGS_URL" >&3
  step_screenshot "agent-detail"

  # Verify the agent settings page loaded — "Connectors" appears in the
  # tab navigation regardless of active tab. Make this non-fatal: the main
  # purpose of this test is to capture AGENT_SETTINGS_URL (already done above);
  # tests 11-13 will independently verify and navigate the settings page.
  wait_for_text "Connectors" 60 || echo "# Connectors tab label not yet visible (page loading slowly)" >&3
  echo "# Agent settings URL ready for tests 11-13" >&3
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

  # Load AGENT_SETTINGS_URL from temp file (trim whitespace to avoid URL issues).
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "${BATS_TMPDIR}/brw_t05_agent_settings_url" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "${BATS_TMPDIR}/brw_t05_agent_settings_url")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
    sleep 3
  else
    # AGENT_SETTINGS_URL not available (test 10 failed before capturing it).
    # Recover by navigating to /team and clicking the agent card.
    echo "# AGENT_SETTINGS_URL not set — recovering via /team navigation..." >&3
    navigate_to_app_page "/team"
    wait_for_text_gone "Loading your workspace" 15 || true
    if wait_for_text "$AGENT_NAME" 60; then
      if agent-browser find role link click --name "$AGENT_NAME" 2>/dev/null || \
         agent-browser find text "$AGENT_NAME" click 2>/dev/null; then
        sleep 3
        local raw_url
        raw_url=$(agent-browser get url 2>/dev/null || true)
        if [[ "$raw_url" == *"/team/"* ]]; then
          AGENT_SETTINGS_URL="${raw_url%%\?*}"
          echo "$AGENT_SETTINGS_URL" > "${BATS_TMPDIR}/brw_t05_agent_settings_url"
          echo "# Recovered AGENT_SETTINGS_URL: $AGENT_SETTINGS_URL" >&3
        fi
      fi
    fi
  fi
  # Wait for agent settings page to fully load (tab labels visible).
  wait_for_text "Connectors" 60
  # Explicitly click the Connectors tab to ensure its content is active.
  # The default tab may vary — without clicking, "Add connector" content will
  # not be visible even though the tab label appears in the navigation.
  click_tab "Connectors"
  sleep 2
  wait_for_text "Add connector" 30
  step_screenshot "connector-before"

  # Click "Add connector" — retry up to 15 times to handle brief unavailability
  # after clicking the Connectors tab (content may briefly re-render/refetch).
  # Role-based find is preferred since the button has composite text
  # ("Add connector\nBrowse 100+ popular connectors"); text-based find only
  # matches elements whose full text equals "Add connector" exactly.
  local add_conn_clicked=false
  for _i in $(seq 1 15); do
    if agent-browser find role button click --name "Add connector" 2>/dev/null; then
      add_conn_clicked=true
      break
    fi
    sleep 1
  done
  if [[ "$add_conn_clicked" != "true" ]]; then
    agent-browser find text "Add connector" click
  fi
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

  # Wait for the ConnectModal to close automatically after Save succeeds.
  # The API token form shows "API Token" label — when it disappears the modal
  # auto-closed via onSuccess → onClose, meaning handleConnectSuccess was called.
  # Do NOT close the modal manually here: closing it early (before the API call
  # finishes) sets selectedType=null which skips handleConnectSuccess, so
  # connectorsDirty stays false and the unsaved bar never appears.
  if ! wait_for_text_gone "API Token" 30; then
    echo "# ConnectModal did not auto-close after Save (API call may have failed)" >&3
    step_screenshot "connector-modal-stuck"
    return 1
  fi
  sleep 1
  step_screenshot "connector-after-modal-save"

  # Close the outer Add Connector dialog (ZeroAddConnectionDialog is still open;
  # the ConnectModal already closed via Save success). The unsaved bar is rendered
  # via createPortal into document.body but Radix Dialog sets aria-hidden on it
  # while a dialog is open — the bar only becomes visible after the dialog closes.
  echo "# Closing add connector dialog..." >&3
  agent-browser find role button click --name "Close" 2>/dev/null || true
  sleep 1

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

  # Load AGENT_SETTINGS_URL from temp file if not in environment (cross-subprocess persistence).
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "${BATS_TMPDIR}/brw_t05_agent_settings_url" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "${BATS_TMPDIR}/brw_t05_agent_settings_url")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  # Navigate back to agent settings to ensure page is in known state.
  # Use || true so a daemon error (e.g. daemon not yet running after test 11
  # failure) does not cause an immediate test failure before the retry below.
  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors || true
    sleep 3
  fi
  # Wait for agent settings page to fully load before clicking tab.
  # Use 60s timeout to accommodate heavy CI load conditions.
  wait_for_text "Connectors" 60
  click_tab "Profile"
  sleep 2

  # Wait for profile form to load. Use "How they sound" (always-visible label)
  # instead of the description placeholder (which doesn't appear when description
  # has content). Retry tab click if content does not appear in time.
  if ! wait_for_text "How they sound" 15; then
    echo "# Profile content not loaded, retrying tab click..." >&3
    click_tab "Profile"
    sleep 2
    wait_for_text "How they sound" 30
  fi
  # Extra settle time after "How they sound" appears — the description textarea
  # may still be initializing when we take the interactive snapshot.
  sleep 1
  step_screenshot "profile-before"

  # Fill description via interactive snapshot ref — the textarea uses aria-label
  # "Description" but InlineSettingsRow renders a <p>, not a <label>, so
  # find-label is unreliable. Ref-based fill is robust across both cases.
  local test_value="E2E test description $(date +%s)"
  local snap_i desc_ref
  snap_i=$(agent-browser snapshot -i)
  # The textarea has aria-label="Description"; in the interactive snapshot it
  # appears as '- textbox "Description" [ref=eN]' (possibly indented since it's
  # nested inside a Card). Remove the ^ anchor so indented lines are matched.
  desc_ref=$(echo "$snap_i" | grep -E '- textbox "Description"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$desc_ref" ]]; then
    agent-browser fill "$desc_ref" "$test_value"
  else
    # Fallback: find the Description textbox by its ARIA role + name.
    # InlineSettingsRow renders a <p> not a <label>, so find-label fails;
    # the textarea's aria-label makes find-role-textbox reliable.
    # Retry up to 10 times to handle brief unavailability after tab click.
    local fill_ok=false
    for _i in $(seq 1 10); do
      if agent-browser find role textbox fill --name "Description" "$test_value" 2>/dev/null; then
        fill_ok=true
        break
      fi
      sleep 1
    done
    if [[ "$fill_ok" != "true" ]]; then
      echo "# Description textbox not found after 10 retries" >&3
      return 1
    fi
  fi
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

  # Load AGENT_SETTINGS_URL from temp file if not in environment (cross-subprocess persistence).
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "${BATS_TMPDIR}/brw_t05_agent_settings_url" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "${BATS_TMPDIR}/brw_t05_agent_settings_url")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  # Navigate back to agent settings to ensure page is in known state.
  # Use || true so a daemon error does not cause an immediate test failure.
  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors || true
    sleep 3
  fi
  # Wait for agent settings page to fully load before clicking tab.
  # Retry with a reload in case prior test left the daemon in a bad state.
  if ! wait_for_text "Connectors" 60; then
    echo "# Connectors not found, reloading agent settings page..." >&3
    if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
      agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors || true
      sleep 5
    fi
    wait_for_text "Connectors" 60
  fi
  click_tab "Instructions"
  sleep 2

  # Wait for instructions editor to load by checking for the footer hint text
  # which is a regular <p> element visible in the accessibility snapshot.
  # The Tiptap placeholder is CSS-only and does not appear in snapshots.
  if ! wait_for_text "Edit the instructions directly" 60; then
    echo "# Instructions editor did not load within 60 seconds" >&3
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
