#!/usr/bin/env bats
# brw-t01-auth.bats — Clerk sign-in/sign-up + CLI device-code auth via agent-browser
#
# Two sequential tests sharing a browser session:
#   1. Sign up or sign in via Clerk
#   2. Complete CLI device code auth
#
# Required env vars:
#   VM0_API_URL   — Target site URL
#
# Optional env vars:
#   E2E_ACCOUNT   — Test email (auto-generated if empty)

load '../../helpers/setup'
load '../../helpers/browser'

# ---------------------------------------------------------------------------
# File-level setup: initialize browser helpers and start CLI auth login
# ---------------------------------------------------------------------------
setup_file() {
  browser_setup

  echo "# CLI authentication via agent-browser" >&3
  echo "#   URL:   $VM0_API_URL" >&3
  echo "#   Email: $E2E_ACCOUNT" >&3

  # Start vm0 auth login in background and capture device code
  export CLI_LOG
  CLI_LOG=$(mktemp)

  NODE_TLS_REJECT_UNAUTHORIZED=0 VM0_API_URL="$VM0_API_URL" vm0 auth login > "$CLI_LOG" 2>&1 &
  export CLI_PID=$!

  export DEVICE_CODE=""
  for _i in $(seq 1 30); do
    local code_match
    code_match=$(grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' "$CLI_LOG" 2>/dev/null | head -1) || true
    if [[ -n "$code_match" ]]; then
      DEVICE_CODE="$code_match"
      export DEVICE_CODE
      break
    fi
    if ! kill -0 "$CLI_PID" 2>/dev/null; then
      echo "# vm0 auth login exited unexpectedly:" >&3
      cat "$CLI_LOG" >&3
      return 1
    fi
    sleep 1
  done

  if [[ -z "$DEVICE_CODE" ]]; then
    echo "# Failed to get device code within 30s" >&3
    cat "$CLI_LOG" >&3
    return 1
  fi

  echo "# Got device code: $DEVICE_CODE" >&3
}

# ---------------------------------------------------------------------------
# File-level teardown: kill CLI process and clean up temp files
# ---------------------------------------------------------------------------
teardown_file() {
  if [[ -n "${CLI_PID:-}" ]]; then
    kill "$CLI_PID" 2>/dev/null || true
    wait "$CLI_PID" 2>/dev/null || true
  fi
  if [[ -n "${CLI_LOG:-}" ]]; then
    rm -f "$CLI_LOG"
  fi
}

# ===========================================================================
# Test 1: Clerk sign-in (or sign-up) via browser
# ===========================================================================
@test "sign up or sign in via Clerk" {
  echo "# Navigating to $VM0_API_URL/sign-in" >&3
  agent-browser open "$VM0_API_URL/sign-in" --ignore-https-errors
  agent-browser wait 3000
  step_screenshot "sign-in-page"

  # Check if already signed in (redirected away from /sign-in)
  local current_url
  current_url=$(agent-browser get url 2>/dev/null || true)
  if [[ -n "$current_url" && ! "$current_url" =~ sign-in ]]; then
    echo "# Already signed in (redirected to $current_url)" >&3
    return 0
  fi

  # Dismiss cookie consent banner early to prevent it from blocking clicks
  dismiss_cookie_banner

  # Wait for Clerk sign-in form
  echo "# Waiting for Clerk sign-in form..." >&3
  local form_appeared=false
  for i in $(seq 1 10); do
    local snap
    snap=$(agent-browser snapshot -i 2>/dev/null || true)
    if contains "$snap" "email address"; then
      form_appeared=true
      break
    fi
    if [[ $i -eq 10 ]]; then
      step_screenshot "sign-in-form-missing"
    fi
    sleep 3
  done
  assert [ "$form_appeared" = "true" ]

  # Enter email on sign-in form and click Continue
  echo "# Entering email: $E2E_ACCOUNT" >&3
  agent-browser find label "Email address" fill "$E2E_ACCOUNT"
  agent-browser wait 500
  click_continue
  agent-browser wait 5000
  step_screenshot "after-email-continue"

  # Decide: sign-in succeeded, need sign-up, or need OTP?
  local snap
  snap=$(full_snapshot)

  if contains "$snap" "identifier is invalid\|couldn.t find your account"; then
    # ---- Account does not exist -> sign-up flow ----
    step_screenshot "account-not-found"
    echo "# Account not found - switching to sign-up flow" >&3

    local signup_password
    signup_password="$(generate_password)"

    agent-browser open "$VM0_API_URL/sign-up" --ignore-https-errors
    agent-browser wait 3000

    local signup_form_appeared=false
    for i in $(seq 1 10); do
      snap=$(agent-browser snapshot -i 2>/dev/null || true)
      if contains "$snap" "email address"; then
        signup_form_appeared=true
        break
      fi
      if [[ $i -eq 10 ]]; then
        step_screenshot "sign-up-form-missing"
      fi
      sleep 3
    done
    assert [ "$signup_form_appeared" = "true" ]

    step_screenshot "sign-up-form"
    echo "# Filling sign-up form" >&3
    agent-browser find label "Email address" fill "$E2E_ACCOUNT"
    agent-browser wait 500
    agent-browser find label "Password" fill "$signup_password"
    agent-browser wait 500
    click_continue
    agent-browser wait 5000
    step_screenshot "after-sign-up-continue"

    snap=$(full_snapshot)
    if contains "$snap" "verify your email\|verification code"; then
      enter_otp "$OTP"
      step_screenshot "after-sign-up-otp"
    fi

    # Wait for sign-up to complete
    for _i in $(seq 1 30); do
      snap=$(full_snapshot)
      if ! contains "$snap" "sign.up\|Create your account\|verification code"; then
        break
      fi
      sleep 1
    done

    snap=$(full_snapshot)
    assert [ "$(contains "$snap" "sign.up\|Create your account" && echo "stuck" || echo "ok")" = "ok" ]
    echo "# Sign-up successful!" >&3

  elif ! contains "$snap" "sign.in\|password\|email address"; then
    # ---- Page no longer shows sign-in form -> already authenticated ----
    echo "# Sign-in successful!" >&3

  else
    # ---- Still on sign-in page -> need OTP to complete sign-in ----
    step_screenshot "sign-in-needs-otp"
    echo "# Sign-in requires further verification" >&3

    # If password field is showing, try to switch to email code method
    if contains "$snap" "password"; then
      echo "# Password screen detected - looking for email code option" >&3
      if agent-browser find text "Use another method" click 2>/dev/null \
          || agent-browser find text "use another method" click 2>/dev/null; then
        agent-browser wait 3000
        step_screenshot "after-alt-method-click"
        if agent-browser find text "Email code" click 2>/dev/null \
            || agent-browser find text "email code" click 2>/dev/null; then
          agent-browser wait 3000
        fi
      elif agent-browser find text "Forgot password" click 2>/dev/null \
          || agent-browser find text "forgot password" click 2>/dev/null; then
        agent-browser wait 3000
      fi
    fi

    # Wait for OTP screen, then enter code
    if ! wait_for_otp_screen 10; then
      step_screenshot "otp-screen-not-detected"
    fi

    enter_otp "$OTP"
    step_screenshot "after-sign-in-otp"

    # Wait for sign-in to complete
    for _i in $(seq 1 30); do
      snap=$(full_snapshot)
      if ! contains "$snap" "sign.in\|password\|verification code"; then
        break
      fi
      sleep 1
    done

    snap=$(full_snapshot)
    assert [ "$(contains "$snap" "sign.in\|password" && echo "stuck" || echo "ok")" = "ok" ]
    echo "# Sign-in successful!" >&3
  fi
}

# ===========================================================================
# Test 2: Enter device code on /cli-auth and verify CLI authentication
# ===========================================================================
@test "complete CLI device code auth" {
  assert [ -n "$DEVICE_CODE" ]

  echo "# Entering device code on /cli-auth..." >&3
  agent-browser open "$VM0_API_URL/cli-auth" --ignore-https-errors
  agent-browser wait 3000

  # Wait for the code input fields to appear
  local form_appeared=false
  for i in $(seq 1 10); do
    local snap
    snap=$(agent-browser snapshot -i 2>/dev/null || true)
    if contains "$snap" "Authorize.*CLI\|Verify"; then
      form_appeared=true
      break
    fi
    if [[ $i -eq 10 ]]; then
      step_screenshot "cli-auth-page-failed"
    fi
    sleep 2
  done
  assert [ "$form_appeared" = "true" ]
  step_screenshot "cli-auth-page"

  # Get snapshot and find the 8 textbox refs for device code
  local snap_i
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)

  local -a code_refs=()
  while IFS= read -r line; do
    local ref
    ref=$(extract_ref "$line")
    if [[ -n "$ref" ]]; then
      code_refs+=("$ref")
    fi
  done < <(echo "$snap_i" | grep -i 'textbox \[ref=' || echo "$snap_i" | grep -iE '^\- textbox' || true)

  # Remove hyphen from device code -> 8 characters
  local code_chars
  code_chars=$(echo "$DEVICE_CODE" | tr -d '-')
  echo "# Entering device code: $DEVICE_CODE" >&3

  if [[ ${#code_refs[@]} -ge 8 ]]; then
    for idx in 0 1 2 3 4 5 6 7; do
      local char="${code_chars:$idx:1}"
      agent-browser fill "${code_refs[$idx]}" "$char"
      agent-browser wait 100
    done
  else
    echo "# Expected 8 input refs, found ${#code_refs[@]}. Using keyboard fallback." >&3
    if [[ ${#code_refs[@]} -gt 0 ]]; then
      agent-browser click "${code_refs[0]}"
    else
      agent-browser find first "input" click
    fi
    agent-browser wait 300
    for char in $(echo "$code_chars" | grep -o .); do
      agent-browser press "$char"
      agent-browser wait 100
    done
  fi

  echo "# Device code entered" >&3
  agent-browser wait 1000

  # Click Verify button
  local verify_clicked=false
  if agent-browser find text "Verify" click 2>/dev/null; then
    verify_clicked=true
  elif agent-browser find text "Authorize Device" click 2>/dev/null; then
    verify_clicked=true
  else
    step_screenshot "verify-button-not-found"
  fi
  assert [ "$verify_clicked" = "true" ]

  agent-browser wait 3000
  step_screenshot "after-verify-click"

  # Wait for CLI authentication to complete
  local config_file="$HOME/.vm0/config.json"
  local auth_completed=false

  for _i in $(seq 1 60); do
    # Check CLI log for success message
    if grep -qi "authentication successful\|successfully authenticated\|credentials have been saved" "$CLI_LOG" 2>/dev/null; then
      auth_completed=true
      break
    fi
    # Check if config file appeared (alternative success signal)
    if [[ -f "$config_file" ]] && grep -q '"token"' "$config_file" 2>/dev/null; then
      auth_completed=true
      break
    fi
    # Check if CLI process exited
    if [[ -n "${CLI_PID:-}" ]] && ! kill -0 "$CLI_PID" 2>/dev/null; then
      local exit_code=0
      wait "$CLI_PID" 2>/dev/null && exit_code=$? || exit_code=$?
      CLI_PID=""
      export CLI_PID
      if [[ $exit_code -eq 0 ]]; then
        auth_completed=true
        break
      else
        echo "# CLI process exited with code $exit_code" >&3
        cat "$CLI_LOG" >&3
        break
      fi
    fi
    sleep 1
  done

  if [[ "$auth_completed" != "true" ]]; then
    step_screenshot "cli-auth-timeout"
    echo "# CLI authentication did not complete within 60s" >&3
    echo "# --- CLI log ---" >&3
    cat "$CLI_LOG" >&3
    echo "# --- Browser state ---" >&3
    full_snapshot >&3
  fi
  assert [ "$auth_completed" = "true" ]

  # Verify auth config
  if [[ -f "$config_file" ]]; then
    echo "# Auth config saved to $config_file" >&3
    if grep -q '"token"' "$config_file" 2>/dev/null; then
      echo "# Auth token present" >&3
    fi
  fi

  echo "# CLI authentication flow complete!" >&3
}
