#!/usr/bin/env bash
# cli-auth-automation.sh — Clerk sign-in/sign-up + CLI device-code auth via agent-browser
#
# Usage:
#   bash cli-auth-automation.sh <base-url> [--email <email>]
#
# Example:
#   bash cli-auth-automation.sh "https://www.vm7.ai:8443" --email "user+clerk_test@vm0.ai"
#
# Flow:
#   1. Start `vm0 auth login` in background, capture device code
#   2. Open browser → Clerk sign-in via email code (or sign-up if account doesn't exist)
#   3. Navigate to /cli-auth, enter device code, click Verify
#   4. Wait for CLI to confirm authentication
#   5. Verify ~/.vm0/config.json was created
#
# Sign-in always uses the email code (OTP) flow, never password.
# Sign-up uses a randomly generated password + OTP verification.
#
# Uses agent-browser's built-in browser. No CDP/Playwright needed.

set -eu

OTP="424242"
BASE_URL=""
EMAIL=""
SCREENSHOT_DIR="/tmp/e2e-auth-screenshots"
mkdir -p "$SCREENSHOT_DIR"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      EMAIL="$2"
      shift 2
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      BASE_URL="$1"
      shift
      ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  echo "❌ Usage: bash cli-auth-automation.sh <base-url> [--email <email>]" >&2
  exit 1
fi

if [[ -z "$EMAIL" ]]; then
  # Email must contain "+clerk_test" for Clerk dev-mode OTP (424242) to work.
  # Use a random prefix so each run can sign up a fresh account if needed.
  RANDOM_PREFIX=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 8)
  EMAIL="${RANDOM_PREFIX}+clerk_test@vm0.ai"
fi

echo "🚀 CLI authentication via agent-browser"
echo "   URL:   $BASE_URL"
echo "   Email: $EMAIL"

# ---------------------------------------------------------------------------
# Helper: take a numbered screenshot + snapshot for debugging
# ---------------------------------------------------------------------------
STEP_NUM=0
step_screenshot() {
  STEP_NUM=$((STEP_NUM + 1))
  local label="$1"
  local filename
  filename=$(printf "%02d-%s" "$STEP_NUM" "$label")
  echo "📸 [$filename] Taking screenshot..."
  agent-browser screenshot "$SCREENSHOT_DIR/${filename}.png" 2>/dev/null || true
  agent-browser snapshot > "$SCREENSHOT_DIR/${filename}.txt" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Helper: check if string contains pattern (avoids pipe + grep in conditionals)
# ---------------------------------------------------------------------------
contains() {
  [[ "$(echo "$1" | grep -ci "$2" 2>/dev/null)" -gt 0 ]]
}

# ---------------------------------------------------------------------------
# Helper: extract @eN ref from a snapshot line containing [ref=eN]
# ---------------------------------------------------------------------------
extract_ref() {
  local match
  match=$(echo "$1" | grep -oE '\[ref=e[0-9]+\]' 2>/dev/null | head -1) || true
  if [[ -n "$match" ]]; then
    echo "$match" | sed 's/\[ref=/@/; s/\]//'
  fi
}

# ---------------------------------------------------------------------------
# Helper: get full snapshot text (for detecting error messages etc.)
# ---------------------------------------------------------------------------
full_snapshot() {
  agent-browser snapshot 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Helper: dismiss cookie consent banner if present
# ---------------------------------------------------------------------------
dismiss_cookie_banner() {
  local snap_i
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  local accept_ref
  accept_ref=$(extract_ref "$(echo "$snap_i" | grep -i '"Accept"' | grep -iv 'sign\|google\|continue\|verify' | head -1 || true)")
  if [[ -n "$accept_ref" ]]; then
    agent-browser click "$accept_ref" 2>/dev/null || true
    agent-browser wait 500
    echo "🍪 Dismissed cookie consent banner"
  fi
}

# ---------------------------------------------------------------------------
# Helper: wait until URL no longer contains a pattern
# ---------------------------------------------------------------------------
wait_for_redirect_away() {
  local pattern="$1"
  local timeout_secs="${2:-30}"
  for _i in $(seq 1 "$timeout_secs"); do
    CURRENT_URL=$(agent-browser get url 2>/dev/null || true)
    if [[ -n "$CURRENT_URL" && ! "$CURRENT_URL" =~ $pattern ]]; then
      echo "$CURRENT_URL"
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# Helper: wait for verification/OTP screen to appear
# ---------------------------------------------------------------------------
wait_for_otp_screen() {
  local timeout_secs="${1:-10}"
  for _i in $(seq 1 "$timeout_secs"); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "verify\|verification code\|enter.*code"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------
# Helper: enter OTP verification code
# ---------------------------------------------------------------------------
enter_otp() {
  local code="$1"
  echo "🔢 Entering OTP verification code"

  SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)
  local otp_line otp_ref
  otp_line=$(echo "$SNAP_I" | grep -i "verification code" || true)
  otp_ref=$(extract_ref "$otp_line")

  if [[ -n "$otp_ref" ]]; then
    agent-browser click "$otp_ref"
    agent-browser wait 300
    agent-browser type "$otp_ref" "$code"
  else
    agent-browser find first "input" click
    agent-browser wait 300
    for digit in $(echo "$code" | grep -o .); do
      agent-browser press "$digit"
    done
  fi
  agent-browser wait 2000

  # Click Continue/Verify button if present (needed when OTP is a single text input)
  SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)
  local submit_ref
  submit_ref=$(extract_ref "$(echo "$SNAP_I" | grep -iE '"Continue"|"Verify"' | head -1 || true)")
  if [[ -n "$submit_ref" ]]; then
    echo "➡️ Clicking submit button"
    agent-browser click "$submit_ref"
  fi
  agent-browser wait 5000
}

# ---------------------------------------------------------------------------
# Helper: generate random password for sign-up
# ---------------------------------------------------------------------------
generate_password() {
  # 20-char password: random alphanumeric + guaranteed symbol/upper/lower/digit
  local rand
  rand=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
  echo "${rand:0:16}!Aa1"
}

# ---------------------------------------------------------------------------
# Cleanup handler
# ---------------------------------------------------------------------------
CLI_PID=""
CLI_LOG=""
cleanup() {
  if [[ -n "$CLI_PID" ]]; then
    kill "$CLI_PID" 2>/dev/null || true
    wait "$CLI_PID" 2>/dev/null || true
  fi
  if [[ -n "$CLI_LOG" ]]; then
    rm -f "$CLI_LOG"
  fi
}
trap cleanup EXIT

# ===========================================================================
# Phase 1: Start `vm0 auth login` and capture device code
# ===========================================================================
echo ""
echo "📡 Phase 1: Starting vm0 auth login..."

CLI_LOG=$(mktemp)
NODE_TLS_REJECT_UNAUTHORIZED=0 VM0_API_URL="$BASE_URL" vm0 auth login > "$CLI_LOG" 2>&1 &
CLI_PID=$!

DEVICE_CODE=""
for i in $(seq 1 30); do
  if [[ -n "$(grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' "$CLI_LOG" 2>/dev/null || true)" ]]; then
    DEVICE_CODE=$(grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' "$CLI_LOG" | head -1)
    break
  fi
  if ! kill -0 "$CLI_PID" 2>/dev/null; then
    echo "❌ vm0 auth login exited unexpectedly:" >&2
    cat "$CLI_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ -z "$DEVICE_CODE" ]]; then
  echo "❌ Failed to get device code within 30s" >&2
  cat "$CLI_LOG" >&2
  exit 1
fi

echo "✅ Got device code: $DEVICE_CODE"

# ===========================================================================
# Phase 2: Clerk sign-in (or sign-up) via browser
# ===========================================================================
echo ""
echo "🔐 Phase 2: Clerk authentication..."

echo "🌐 Navigating to $BASE_URL/sign-in"
agent-browser open "$BASE_URL/sign-in" --ignore-https-errors
agent-browser wait 3000
step_screenshot "sign-in-page"

# Check if already signed in (redirected away from /sign-in)
CURRENT_URL=$(agent-browser get url 2>/dev/null || true)
if [[ -n "$CURRENT_URL" && ! "$CURRENT_URL" =~ sign-in ]]; then
  echo "✅ Already signed in (redirected to $CURRENT_URL)"
else
  # Dismiss cookie consent banner early to prevent it from blocking clicks
  dismiss_cookie_banner

  # Wait for Clerk sign-in form
  echo "⏳ Waiting for Clerk sign-in form..."
  for i in $(seq 1 10); do
    SNAP=$(agent-browser snapshot -i 2>/dev/null || true)
    if contains "$SNAP" "email address"; then
      break
    fi
    if [[ $i -eq 10 ]]; then
      step_screenshot "sign-in-form-missing"
      echo "❌ Clerk sign-in form did not appear within 30s" >&2
      exit 1
    fi
    sleep 3
  done

  # -----------------------------------------------------------------------
  # Enter email on sign-in form and click Continue
  # -----------------------------------------------------------------------
  SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)
  EMAIL_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i 'Email address' || true)")
  CONTINUE_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i '"Continue"' || true)")

  echo "📧 Entering email: $EMAIL"
  agent-browser click "$EMAIL_REF"
  agent-browser wait 300
  agent-browser type "$EMAIL_REF" "$EMAIL"
  agent-browser wait 500
  agent-browser click "$CONTINUE_REF"
  agent-browser wait 5000
  step_screenshot "after-email-continue"

  # -----------------------------------------------------------------------
  # Decide: sign-in succeeded, need sign-up, or need OTP?
  # Check snapshot text instead of relying on URL redirects.
  # -----------------------------------------------------------------------
  SNAP=$(full_snapshot)

  if contains "$SNAP" "identifier is invalid\|couldn.t find your account"; then
    # ---- Account does not exist → sign-up flow ----
    step_screenshot "account-not-found"
    echo "📝 Account not found — switching to sign-up flow"

    SIGNUP_PASSWORD="$(generate_password)"

    agent-browser open "$BASE_URL/sign-up" --ignore-https-errors
    agent-browser wait 3000

    for i in $(seq 1 10); do
      SNAP=$(agent-browser snapshot -i 2>/dev/null || true)
      if contains "$SNAP" "email address"; then
        break
      fi
      if [[ $i -eq 10 ]]; then
        step_screenshot "sign-up-form-missing"
        echo "❌ Sign-up form did not appear" >&2
        exit 1
      fi
      sleep 3
    done

    step_screenshot "sign-up-form"
    echo "📧 Filling sign-up form"
    SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)
    EMAIL_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i 'Email address' || true)")
    PASS_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i 'textbox "Password"' || true)")
    CONTINUE_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i '"Continue"' || true)")

    agent-browser click "$EMAIL_REF"
    agent-browser wait 300
    agent-browser type "$EMAIL_REF" "$EMAIL"
    agent-browser wait 500
    agent-browser click "$PASS_REF"
    agent-browser wait 300
    agent-browser type "$PASS_REF" "$SIGNUP_PASSWORD"
    agent-browser wait 500
    agent-browser click "$CONTINUE_REF"
    agent-browser wait 5000
    step_screenshot "after-sign-up-continue"

    SNAP=$(full_snapshot)
    if contains "$SNAP" "verify your email\|verification code"; then
      enter_otp "$OTP"
      step_screenshot "after-sign-up-otp"
    fi

    # Wait for sign-up to complete: page should no longer show sign-up form
    for _i in $(seq 1 30); do
      SNAP=$(full_snapshot)
      if ! contains "$SNAP" "sign.up\|Create your account\|verification code"; then
        break
      fi
      sleep 1
    done

    SNAP=$(full_snapshot)
    if contains "$SNAP" "sign.up\|Create your account"; then
      step_screenshot "sign-up-failed"
      echo "❌ Sign-up did not complete" >&2
      exit 1
    fi
    echo "✅ Sign-up successful!"

  elif ! contains "$SNAP" "sign.in\|password\|email address"; then
    # ---- Page no longer shows sign-in form → already authenticated ----
    echo "✅ Sign-in successful!"

  else
    # ---- Still on sign-in page → need OTP to complete sign-in ----
    step_screenshot "sign-in-needs-otp"
    echo "🔐 Sign-in requires further verification"

    # If password field is showing, try to switch to email code method
    if contains "$SNAP" "password"; then
      echo "🔄 Password screen detected — looking for email code option"
      SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)

      UAM_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i 'use another method' || true)")
      if [[ -z "$UAM_REF" ]]; then
        UAM_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i 'email code\|forgot password' || true)")
      fi
      if [[ -n "$UAM_REF" ]]; then
        echo "🔄 Clicking alternative auth method"
        agent-browser click "$UAM_REF"
        agent-browser wait 3000
        step_screenshot "after-alt-method-click"
        SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)
        EC_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i 'email code' || true)")
        if [[ -n "$EC_REF" ]]; then
          echo "📧 Selecting 'Email code'"
          agent-browser click "$EC_REF"
          agent-browser wait 3000
        fi
      fi
    fi

    # Wait for OTP screen, then enter code
    if ! wait_for_otp_screen 10; then
      echo "⚠️ OTP screen not detected, attempting OTP entry anyway"
      step_screenshot "otp-screen-not-detected"
    fi

    enter_otp "$OTP"
    step_screenshot "after-sign-in-otp"

    # Wait for sign-in to complete: page should no longer show sign-in form
    for _i in $(seq 1 30); do
      SNAP=$(full_snapshot)
      if ! contains "$SNAP" "sign.in\|password\|verification code"; then
        break
      fi
      sleep 1
    done

    SNAP=$(full_snapshot)
    if contains "$SNAP" "sign.in\|password"; then
      step_screenshot "sign-in-failed"
      echo "❌ Sign-in did not complete" >&2
      exit 1
    fi
    echo "✅ Sign-in successful!"
  fi
fi

# ===========================================================================
# Phase 3: Enter device code on /cli-auth page
# ===========================================================================
echo ""
echo "🔑 Phase 3: Entering device code on /cli-auth..."

agent-browser open "$BASE_URL/cli-auth"
agent-browser wait 3000

# Wait for the code input fields to appear
echo "⏳ Waiting for device code form..."
for i in $(seq 1 10); do
  SNAP=$(agent-browser snapshot -i 2>/dev/null || true)
  if contains "$SNAP" "Authorize.*CLI\|Verify"; then
    break
  fi
  if [[ $i -eq 10 ]]; then
    step_screenshot "cli-auth-page-failed"
    echo "❌ CLI auth page did not load" >&2
    exit 1
  fi
  sleep 2
done
step_screenshot "cli-auth-page"

# Get snapshot and find the 8 textbox refs for device code
SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)

# Extract all textbox refs (should be 8 code inputs)
CODE_REFS=()
while IFS= read -r line; do
  ref=$(extract_ref "$line")
  if [[ -n "$ref" ]]; then
    CODE_REFS+=("$ref")
  fi
done < <(echo "$SNAP_I" | grep -i 'textbox \[ref=' || echo "$SNAP_I" | grep -iE '^\- textbox' || true)

# Remove hyphen from device code → 8 characters
CODE_CHARS=$(echo "$DEVICE_CODE" | tr -d '-')
echo "📝 Entering device code: $DEVICE_CODE"

if [[ ${#CODE_REFS[@]} -ge 8 ]]; then
  for idx in 0 1 2 3 4 5 6 7; do
    char="${CODE_CHARS:$idx:1}"
    agent-browser fill "${CODE_REFS[$idx]}" "$char"
    agent-browser wait 100
  done
else
  echo "⚠️ Expected 8 input refs, found ${#CODE_REFS[@]}. Using keyboard fallback."
  if [[ ${#CODE_REFS[@]} -gt 0 ]]; then
    agent-browser click "${CODE_REFS[0]}"
  else
    agent-browser find first "input" click
  fi
  agent-browser wait 300
  for char in $(echo "$CODE_CHARS" | grep -o .); do
    agent-browser press "$char"
    agent-browser wait 100
  done
fi

echo "✅ Device code entered"
agent-browser wait 1000

# Click Verify button
SNAP_I=$(agent-browser snapshot -i 2>/dev/null || true)
VERIFY_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i '"Verify"' || true)")

if [[ -n "$VERIFY_REF" ]]; then
  agent-browser click "$VERIFY_REF"
  echo "➡️ Clicked Verify"
else
  AUTH_REF=$(extract_ref "$(echo "$SNAP_I" | grep -i '"Authorize Device"' || true)")
  if [[ -n "$AUTH_REF" ]]; then
    agent-browser click "$AUTH_REF"
    echo "➡️ Clicked Authorize Device"
  else
    step_screenshot "verify-button-not-found"
    echo "❌ Verify button not found" >&2
    echo "$SNAP_I" >&2
    exit 1
  fi
fi

agent-browser wait 3000
step_screenshot "after-verify-click"

# ===========================================================================
# Phase 4: Wait for CLI authentication to complete
# ===========================================================================
echo ""
echo "⏳ Phase 4: Waiting for CLI authentication..."

CONFIG_FILE="$HOME/.vm0/config.json"
CLI_AUTH_TIMEOUT=60

for i in $(seq 1 "$CLI_AUTH_TIMEOUT"); do
  # Check CLI log for success message
  if grep -qi "authentication successful\|successfully authenticated\|credentials have been saved" "$CLI_LOG" 2>/dev/null; then
    echo "✅ CLI authentication successful!"
    break
  fi
  # Check if config file appeared (alternative success signal)
  if [[ -f "$CONFIG_FILE" ]] && grep -q '"token"' "$CONFIG_FILE" 2>/dev/null; then
    echo "✅ CLI authentication successful (config file detected)!"
    break
  fi
  # Check if CLI process exited
  if ! kill -0 "$CLI_PID" 2>/dev/null; then
    wait "$CLI_PID" 2>/dev/null && EXIT_CODE=$? || EXIT_CODE=$?
    CLI_PID=""
    if [[ $EXIT_CODE -eq 0 ]]; then
      echo "✅ CLI process exited successfully"
      break
    else
      echo "❌ CLI process exited with code $EXIT_CODE" >&2
      cat "$CLI_LOG" >&2
      exit 1
    fi
  fi
  if [[ $i -eq $CLI_AUTH_TIMEOUT ]]; then
    step_screenshot "cli-auth-timeout"
    echo "❌ CLI authentication did not complete within ${CLI_AUTH_TIMEOUT}s" >&2
    echo "--- CLI log ---" >&2
    cat "$CLI_LOG" >&2
    echo "--- Browser state ---" >&2
    full_snapshot >&2
    exit 1
  fi
  sleep 1
done

# ===========================================================================
# Phase 5: Verify auth config
# ===========================================================================
if [[ -f "$CONFIG_FILE" ]]; then
  echo "✅ Auth config saved to $CONFIG_FILE"
  if grep -q '"token"' "$CONFIG_FILE" 2>/dev/null; then
    echo "✅ Auth token present"
  fi
else
  echo "⚠️ Auth config file not found at $CONFIG_FILE"
fi

echo ""
echo "🎉 CLI authentication flow complete!"
