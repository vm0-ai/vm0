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
# _agent_url_file — Return the temp file path for the agent settings URL.
#
# Uses JOB_REF (set by CI before BATS starts) for a stable, unique path per
# CI run that is reliably inherited by all BATS test subprocesses. This avoids
# the BRW_T05_TMPDIR approach where the mktemp-created variable is set in
# setup_file but may not be inherited by later @test subprocesses in some
# BATS/GNU-parallel execution models.
#
# Falls back to BRW_T05_TMPDIR (legacy) or a fixed path if JOB_REF is unset
# (e.g. local runs without CI environment).
# ---------------------------------------------------------------------------
_agent_url_file() {
  if [[ -n "${JOB_REF:-}" ]]; then
    echo "/tmp/.brw-t05-agent-url-${JOB_REF}"
  elif [[ -n "${BRW_T05_TMPDIR:-}" ]]; then
    echo "${BRW_T05_TMPDIR}/agent-settings-url"
  else
    echo "/tmp/.brw-t05-agent-url-local"
  fi
}

# ---------------------------------------------------------------------------
# click_tab — Click a tab by its text label
# Tries role-based find first (most reliable), then falls back to interactive
# snapshot parsing which can have quote/format variations across environments.
# ---------------------------------------------------------------------------
click_tab() {
  local tab_text="$1"
  wait_for_text "$tab_text" 30
  # Try role-based finds first (tab/link/button) — avoids snapshot brittle matching.
  # Agent settings may use different ARIA roles across environments.
  if agent-browser find role tab click --name "$tab_text" 2>/dev/null; then
    return 0
  fi
  if agent-browser find role link click --name "$tab_text" 2>/dev/null; then
    return 0
  fi
  if agent-browser find role button click --name "$tab_text" 2>/dev/null; then
    return 0
  fi
  # Fallback: parse interactive snapshot with flexible role matching
  local snap_i ref
  snap_i=$(agent-browser snapshot -i)
  ref=$(echo "$snap_i" | grep -iE "(tab|link|button|menuitem).*\"${tab_text}\"" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$ref" ]]; then
    agent-browser click "$ref"
    return 0
  fi
  # Last resort: direct text click (clicks any element containing the text)
  if agent-browser find text "$tab_text" click 2>/dev/null; then
    return 0
  fi
  echo "# Failed to find tab ref for '${tab_text}'" >&3
  return 1
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

  # Shared temp dir for persisting data across test subprocesses in this file.
  # Exported so all @test subshells can read/write the agent settings URL file.
  BRW_T05_TMPDIR=$(mktemp -d)
  export BRW_T05_TMPDIR

  # Clear any stale agent URL from previous CI runs on the same runner to prevent
  # cross-run contamination (the JOB_REF-based path is stable across runs).
  rm -f "$(_agent_url_file)" 2>/dev/null || true

  echo "# Agent settings editing flow via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Agent name: $AGENT_NAME" >&3
  echo "#   Tmpdir: $BRW_T05_TMPDIR" >&3
}

teardown_file() {
  # Clean up the created agent to prevent orphan accumulation
  if [[ -n "${AGENT_NAME:-}" ]]; then
    $ZERO_CLI agent delete "$AGENT_NAME" --yes 2>/dev/null || true
    rm -f "$(_agent_url_file)" 2>/dev/null || true
  fi
  rm -rf "${BRW_T05_TMPDIR:-}" 2>/dev/null || true

  browser_teardown
}

@test "sign in via token on platform app" {
  sign_in_via_token_on_app
}

@test "create agent for settings testing" {
  echo "# Navigating to team page..." >&3
  navigate_to_app_page "/team"

  # Retry clicking Create teammate — same approach as brw-t03-team which reliably
  # handles the case where the button is visible but not yet interactable (e.g.
  # still loading, or focus is elsewhere). A single click + long wait is fragile.
  echo "# Clicking Create teammate (with retry)..." >&3
  local btn_clicked=false
  for _i in $(seq 1 30); do
    if agent-browser find role button click --name "Create teammate" 2>/dev/null; then
      btn_clicked=true
      break
    fi
    sleep 1
  done
  if [[ "$btn_clicked" != "true" ]]; then
    echo "# Could not click Create teammate button after 30 attempts" >&3
    agent-browser snapshot 2>/dev/null | head -20 >&3 || true
    return 1
  fi
  sleep 1

  local dialog_opened=false
  if wait_for_text "Create a new teammate" 15; then
    dialog_opened=true
  fi
  if [[ "$dialog_opened" != "true" ]]; then
    echo "# Dialog did not appear after successful click" >&3
    agent-browser snapshot 2>/dev/null | head -20 >&3 || true
    return 1
  fi
  step_screenshot "create-dialog"

  # Fill agent name
  echo "# Filling agent name: $AGENT_NAME" >&3
  agent-browser find placeholder "e.g. Research Assistant" fill "$AGENT_NAME"
  sleep 0.5
  step_screenshot "create-dialog-filled"

  # Click the Create button using --exact to avoid partial-matching the background
  # "Create teammate" button (which would dismiss the modal). Same approach as brw-t03.
  echo "# Clicking Create button in dialog..." >&3
  local create_clicked=false
  for _i in $(seq 1 10); do
    if agent-browser find role button click --name "Create" --exact 2>/dev/null; then
      create_clicked=true
      break
    fi
    sleep 1
  done
  if [[ "$create_clicked" != "true" ]]; then
    # Fallback without --exact in case accessible name includes extra text
    agent-browser find role button click --name "Create" 2>/dev/null || true
  fi
  sleep 1

  # Wait for dialog to close (confirms backend creation API call completed).
  # Reduced to 20s — non-fatal, we capture the URL separately below.
  local dialog_closed=false
  if wait_for_text_gone "Create a new teammate" 20; then
    dialog_closed=true
  else
    echo "# Dialog close timed out — agent creation may still be in progress" >&3
  fi

  # While still signed in with the same browser session, try to capture the
  # agent settings URL. The app may navigate there automatically after creation,
  # or the agent may appear in the /team list. Saving the URL here avoids the
  # overhead of daemon restart + sign-in + /team search in test 10.
  if [[ "$dialog_closed" = "true" ]]; then
    # Check if app already navigated to agent settings upon creation
    sleep 2
    local post_create_url
    post_create_url=$(agent-browser get url 2>/dev/null | tr -d '[:space:]' || true)
    echo "# URL after dialog close: $post_create_url" >&3
    if [[ "$post_create_url" =~ /(talk|team)/[a-zA-Z0-9] ]]; then
      echo "$post_create_url" > "$(_agent_url_file)"
      echo "# Captured agent settings URL from post-create nav: $post_create_url to $(_agent_url_file)" >&3
    else
      # App stayed on /team — wait for agent card and click it to get the URL
      echo "# Waiting for agent to appear on /team to capture settings URL..." >&3
      if wait_for_text "$AGENT_NAME" 40; then
        if agent-browser find text "$AGENT_NAME" click 2>/dev/null; then
          sleep 3
          local agent_url
          agent_url=$(agent-browser get url 2>/dev/null | tr -d '[:space:]' || true)
          echo "# URL after clicking agent card: $agent_url" >&3
          if [[ "$agent_url" =~ /(talk|team)/[a-zA-Z0-9] ]]; then
            echo "$agent_url" > "$(_agent_url_file)"
            echo "# Saved agent settings URL: $agent_url to $(_agent_url_file)" >&3
          fi
        fi
      else
        echo "# Agent not yet visible on /team — URL will be determined in test 10" >&3
      fi
    fi
  fi

  step_screenshot "agent-created"
  echo "# Agent created: $AGENT_NAME" >&3
}

@test "navigate to agent settings and verify tabs" {
  # Capture agent settings URL from the daemon BEFORE restarting it.
  # Test 9 leaves the browser at the agent settings page. Getting the URL here
  # avoids any file-sharing race conditions (BATS --jobs parallelizes within
  # a file, so file writes from one @test are not guaranteed to be visible to
  # another @test that started concurrently).
  local pre_restart_url
  pre_restart_url=$(agent-browser get url 2>/dev/null | tr -d '[:space:]' || true)
  echo "# URL from test 9's browser session: $pre_restart_url" >&3
  if [[ "$pre_restart_url" =~ /(talk)/[a-zA-Z0-9] ]]; then
    echo "# Captured agent settings URL from live daemon: $pre_restart_url" >&3
    AGENT_SETTINGS_URL="$pre_restart_url"
    echo "$AGENT_SETTINGS_URL" > "$(_agent_url_file)" 2>/dev/null || true
  fi

  # Restart daemon for a clean browser state, then sign in fresh.
  echo "# Restarting daemon for clean state..." >&3
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app
  wait_for_text_gone "Loading your workspace" 20 || true
  echo "# Navigating to agent settings for: $AGENT_NAME..." >&3

  # Also check temp file (may have been written by test 9 if sequential).
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "$(_agent_url_file)" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "$(_agent_url_file)")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    # URL captured from live daemon or temp file — navigate directly.
    echo "# Navigating directly to agent settings: $AGENT_SETTINGS_URL" >&3
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
    sleep 3
    # Close any stale dialogs that may have persisted from a previous run or
    # auto-opened on page load (e.g. ConnectModal for an already-connected service).
    agent-browser press "Escape" 2>/dev/null || true
    sleep 1
  else
    # URL not available — find agent on /team page with retry.
    echo "# Agent settings URL not pre-captured, finding via /team..." >&3
    navigate_to_app_page "/team"
    # Use the same approach as test 11's successful recovery: navigate to /team,
    # wait briefly (non-fatal), then take an interactive snapshot and click the ref.
    # Avoid long retry loops that waste time — if the agent isn't found after one
    # attempt, navigate once more and try again.
    wait_for_text "$AGENT_NAME" 40 || navigate_to_app_page "/team"
    wait_for_text "$AGENT_NAME" 40 || true
    step_screenshot "team-page"
    local snap_i_card card_ref
    snap_i_card=$(agent-browser snapshot -i 2>/dev/null || true)
    card_ref=$(echo "$snap_i_card" | grep -i "${AGENT_NAME}" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    echo "# Agent card ref: '${card_ref}'" >&3
    if [[ -n "$card_ref" ]]; then
      agent-browser click "$card_ref" 2>/dev/null || true
    else
      agent-browser find role link click --name "$AGENT_NAME" 2>/dev/null || \
        agent-browser find text "$AGENT_NAME" click 2>/dev/null || true
    fi
    sleep 3
    local clicked_url
    clicked_url=$(agent-browser get url 2>/dev/null | tr -d '[:space:]' || true)
    echo "# URL after clicking agent: $clicked_url" >&3
    if [[ "$clicked_url" =~ /(talk)/[a-zA-Z0-9] ]]; then
      AGENT_SETTINGS_URL="$clicked_url"
      export AGENT_SETTINGS_URL
      echo "$AGENT_SETTINGS_URL" > "$(_agent_url_file)" 2>/dev/null || true
    else
      echo "# Could not navigate to agent settings page" >&3
      return 1
    fi
  fi

  # Verify the page loaded and we're on the correct agent's settings page.
  wait_for_text "Connectors" 20 || echo "# Connectors tab not yet visible (page loading slowly)" >&3
  # Verify agent name is visible — if not, we navigated to the wrong agent.
  # Fall back to /team search to find the correct agent.
  if ! wait_for_text "$AGENT_NAME" 10; then
    echo "# WARN: '$AGENT_NAME' not visible — searching on /team..." >&3
    agent-browser snapshot 2>/dev/null | head -20 >&3 || true
    navigate_to_app_page "/team"
    wait_for_text "$AGENT_NAME" 40 || true
    local snap_i_fb fb_ref
    snap_i_fb=$(agent-browser snapshot -i 2>/dev/null || true)
    fb_ref=$(echo "$snap_i_fb" | grep -i "${AGENT_NAME}" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    if [[ -n "$fb_ref" ]]; then
      agent-browser click "$fb_ref" 2>/dev/null || true
      sleep 3
      local fb_url
      fb_url=$(agent-browser get url 2>/dev/null | tr -d '[:space:]' || true)
      if [[ "$fb_url" =~ /(talk)/[a-zA-Z0-9] ]]; then
        AGENT_SETTINGS_URL="$fb_url"
        echo "$AGENT_SETTINGS_URL" > "$(_agent_url_file)" 2>/dev/null || true
        echo "# Recovered URL via /team: $AGENT_SETTINGS_URL" >&3
      fi
    else
      echo "# Could not find '$AGENT_NAME' on /team — agent creation may have failed" >&3
      return 1
    fi
  fi
  step_screenshot "agent-detail"
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
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "$(_agent_url_file)" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "$(_agent_url_file)")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
    sleep 3
  else
    # AGENT_SETTINGS_URL not available — recover via snapshot click on /team page.
    echo "# AGENT_SETTINGS_URL not set — recovering via /team snapshot click..." >&3
    navigate_to_app_page "/team"
    wait_for_text "$AGENT_NAME" 30 || true
    local snap_i_r agent_ref_r
    snap_i_r=$(agent-browser snapshot -i 2>/dev/null || true)
    agent_ref_r=$(echo "$snap_i_r" | grep -i "${AGENT_NAME}" | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    echo "# Recovery snapshot ref: '$agent_ref_r'" >&3
    if [[ -n "$agent_ref_r" ]]; then
      agent-browser click "$agent_ref_r" 2>/dev/null || true
      sleep 3
      local recovered_url
      recovered_url=$(agent-browser get url 2>/dev/null | tr -d '[:space:]' || true)
      echo "# Recovery URL after click: $recovered_url" >&3
      if [[ "$recovered_url" =~ /(talk|team)/[a-zA-Z0-9] ]]; then
        AGENT_SETTINGS_URL="$recovered_url"
        echo "$AGENT_SETTINGS_URL" > "$(_agent_url_file)"
        echo "# Recovered AGENT_SETTINGS_URL: $AGENT_SETTINGS_URL" >&3
      fi
    fi
    if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
      agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors
      sleep 3
    fi
  fi
  # Wait for agent settings page to fully load (tab labels visible).
  wait_for_text "Connectors" 30
  # Explicitly click the Connectors tab to ensure its content is active.
  # The default tab may vary — without clicking, "Add connector" content will
  # not be visible even though the tab label appears in the navigation.
  click_tab "Connectors"
  sleep 2
  wait_for_text "Add connector" 20
  step_screenshot "connector-before"

  # Click "Add connector" via interactive snapshot ref — the button has composite
  # text so accessible-name exact matching ("find role button --name 'Add connector'")
  # may not work if the computed accessible name includes the subtitle text.
  # Parsing the ref from the interactive snapshot is more robust.
  local snap_i add_conn_ref
  snap_i=$(agent-browser snapshot -i)
  add_conn_ref=$(echo "$snap_i" | grep -i 'Add connector' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$add_conn_ref" ]]; then
    agent-browser click "$add_conn_ref"
  else
    # Fallback: role-based with retry (handles transient unavailability after tab switch)
    local add_conn_clicked=false
    for _i in $(seq 1 20); do
      if agent-browser find role button click --name "Add connector" 2>/dev/null; then
        add_conn_clicked=true
        break
      fi
      sleep 1
    done
    if [[ "$add_conn_clicked" != "true" ]]; then
      echo "# Add connector button not found in snapshot or via role-based find" >&3
      step_screenshot "add-connector-not-found"
      return 1
    fi
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
  # Use Escape key (most reliable for Radix UI dialogs) to close the outer dialog.
  echo "# Closing add connector dialog..." >&3
  agent-browser press "Escape" 2>/dev/null || true
  sleep 1
  # Verify the outer dialog actually closed; if not, try clicking the Close button.
  if agent-browser snapshot 2>/dev/null | grep -q '"Add connector'; then
    echo "# Outer dialog still open after Escape — clicking Close button..." >&3
    agent-browser find role button click --name "Close" 2>/dev/null || true
    sleep 1
  fi

  # Verify the unsaved bar appeared (confirms connector was added to the list).
  # Increased timeout: CI load can delay React state propagation after dialog close.
  wait_for_unsaved_bar 30
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

  # Restart daemon for clean state — test 11 may leave a dialog open (Escape
  # key does not always dismiss the outer Add Connector dialog on first press).
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app
  wait_for_text_gone "Loading your workspace" 30 || true

  # Load AGENT_SETTINGS_URL from temp file if not in environment (cross-subprocess persistence).
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "$(_agent_url_file)" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "$(_agent_url_file)")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  # Navigate to agent settings.
  if [[ -n "${AGENT_SETTINGS_URL:-}" ]]; then
    agent-browser open "$AGENT_SETTINGS_URL" --ignore-https-errors || true
    sleep 3
  fi
  # Wait for agent settings page to fully load before clicking tab.
  # Use 60s timeout to accommodate heavy CI load conditions.
  wait_for_text "Connectors" 60
  # Verify agent name and Profile tab are visible — Profile/Instructions are hidden
  # for the default (Lead) agent when the user is non-admin. If the agent name is
  # not visible, we may have navigated to the wrong agent page.
  if ! wait_for_text "$AGENT_NAME" 5; then
    echo "# WARN: '$AGENT_NAME' not visible — may be on wrong agent page" >&3
    agent-browser snapshot 2>/dev/null | head -30 >&3 || true
  fi
  if ! wait_for_text "Profile" 10; then
    echo "# Profile tab not visible — printing page snapshot for debugging" >&3
    agent-browser snapshot 2>/dev/null | head -30 >&3 || true
  fi
  click_tab "Profile"
  sleep 2

  # Wait for profile form to load. Use "How they sound" (always-visible label)
  # instead of the description placeholder (which doesn't appear when description
  # has content). Retry tab click if content does not appear in time.
  if ! wait_for_text "How they sound" 15; then
    echo "# Profile content not loaded, retrying tab click..." >&3
    click_tab "Profile"
    sleep 3
    wait_for_text "How they sound" 30
  fi
  # Extra settle time — the description textarea may still be initializing
  # even after "How they sound" appears. Give the form a moment to fully render.
  sleep 2
  step_screenshot "profile-before"

  local test_value="E2E test description $(date +%s)"
  # Fill description via interactive snapshot ref — the textarea uses aria-label
  # "Description" but InlineSettingsRow renders a <p>, not a <label>, so
  # find-label is unreliable. Ref-based fill is robust across both cases.
  # Retry snapshot up to 3 times in case the textarea is still rendering.
  local snap_i desc_ref fill_done=false
  for _snap_try in 1 2 3; do
    snap_i=$(agent-browser snapshot -i)
    # The textarea has aria-label="Description"; in the interactive snapshot it
    # appears as '- textbox "Description" [ref=eN]' (possibly indented since it's
    # nested inside a Card). Remove the ^ anchor so indented lines are matched.
    desc_ref=$(echo "$snap_i" | grep -E 'textbox "Description"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    if [[ -n "$desc_ref" ]]; then
      agent-browser fill "$desc_ref" "$test_value"
      fill_done=true
      break
    fi
    sleep 2
  done
  if [[ "$fill_done" != "true" ]]; then
    # Fallback 1: find by placeholder text (most direct — does not rely on ARIA name).
    if agent-browser find placeholder "What does this agent do?" fill "$test_value" 2>/dev/null; then
      fill_done=true
    fi
  fi
  if [[ "$fill_done" != "true" ]]; then
    # Fallback 2: find by ARIA role + name.
    # InlineSettingsRow renders a <p> not a <label>, so find-label fails;
    # the textarea's aria-label makes find-role-textbox reliable.
    # Retry up to 15 times to handle brief unavailability after tab click.
    local fill_ok=false
    for _i in $(seq 1 15); do
      if agent-browser find role textbox fill --name "Description" "$test_value" 2>/dev/null; then
        fill_ok=true
        break
      fi
      sleep 1
    done
    if [[ "$fill_ok" == "true" ]]; then
      fill_done=true
    fi
  fi
  if [[ "$fill_done" != "true" ]]; then
    echo "# Description textbox not found after retries" >&3
    return 1
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

  # Restart daemon for clean state — test 12 may leave the browser in an
  # unknown state; a fresh daemon + sign-in guarantees a stable baseline.
  restart_browser_daemon
  create_clerk_sign_in_token
  sign_in_via_token_on_app
  wait_for_text_gone "Loading your workspace" 30 || true

  # Load AGENT_SETTINGS_URL from temp file if not in environment (cross-subprocess persistence).
  if [[ -z "${AGENT_SETTINGS_URL:-}" ]] && [[ -f "$(_agent_url_file)" ]]; then
    AGENT_SETTINGS_URL=$(tr -d '[:space:]' < "$(_agent_url_file)")
    echo "# Loaded AGENT_SETTINGS_URL from temp file: $AGENT_SETTINGS_URL" >&3
  fi

  # Navigate back to agent settings to ensure page is in known state.
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
