#!/usr/bin/env bats
# brw-t07-upgrade-pro.bats — Verify Pro plan upgrade flow via Stripe checkout
#
# Tests the full user flow: sign in via Clerk token → complete onboarding →
# click "Get Pro" → fill Stripe test card → subscribe → verify Pro plan active.
#
# Uses Stripe CLI to forward webhooks to the local dev server so that
# checkout.session.completed and invoice.paid events are processed correctly.
#
# Required env vars:
#   VM0_API_URL          — Target web app URL (e.g., https://www.vm7.ai:8443)
#   STRIPE_SECRET_KEY    — Stripe test-mode secret key (sk_test_...)
#   CLERK_SECRET_KEY     — Clerk Backend API key (for creating sign-in tokens)

load '../../helpers/setup'
load '../../helpers/browser'

# ---------------------------------------------------------------------------
# File-level setup: start Stripe webhook forwarding, init browser
# ---------------------------------------------------------------------------
setup_file() {
  # Close any existing agent-browser daemon so we start with a clean session
  agent-browser close 2>/dev/null || true
  sleep 1

  browser_setup

  if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
    echo "STRIPE_SECRET_KEY is required but not set" >&2
    return 1
  fi

  if ! command -v stripe &>/dev/null; then
    echo "stripe CLI is not installed" >&2
    return 1
  fi

  APP_URL="$(derive_app_url)"
  export APP_URL

  # Create a fresh Clerk user and sign-in token (ensures clean Free tier state)
  create_clerk_user_and_token

  # Start Stripe webhook forwarding in background
  # In CI, forward to the preview deployment; locally, forward to localhost
  local webhook_url
  if [[ "$VM0_API_URL" == *"localhost"* ]] || [[ "$VM0_API_URL" == *"vm7.ai"* ]]; then
    webhook_url="http://localhost:3000/api/webhooks/stripe"
  else
    webhook_url="${VM0_API_URL}/api/webhooks/stripe"
  fi
  echo "# Stripe webhook forward target: $webhook_url" >&3
  export STRIPE_WEBHOOK_LOG="/tmp/stripe-webhook-forward.log"
  stripe listen \
    --api-key "$STRIPE_SECRET_KEY" \
    --forward-to "$webhook_url" \
    --events checkout.session.completed,invoice.paid,customer.subscription.updated,customer.subscription.deleted \
    > "$STRIPE_WEBHOOK_LOG" 2>&1 &
  export STRIPE_LISTEN_PID=$!

  # Wait for stripe listen to be ready (look for "Ready!" in output)
  local ready=false
  for _i in $(seq 1 30); do
    if grep -qi "ready" "$STRIPE_WEBHOOK_LOG" 2>/dev/null; then
      ready=true
      break
    fi
    sleep 1
  done

  if [[ "$ready" != "true" ]]; then
    echo "# WARNING: stripe listen may not be ready yet" >&3
    cat "$STRIPE_WEBHOOK_LOG" >&3 2>/dev/null || true
  fi

  echo "# Upgrade Pro flow verification via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
  echo "#   Stripe webhook PID: $STRIPE_LISTEN_PID" >&3
}

# ---------------------------------------------------------------------------
# File-level teardown: stop Stripe forwarding, kill browser
# ---------------------------------------------------------------------------
teardown_file() {
  # Stop stripe listen
  if [[ -n "${STRIPE_LISTEN_PID:-}" ]]; then
    kill "$STRIPE_LISTEN_PID" 2>/dev/null || true
    wait "$STRIPE_LISTEN_PID" 2>/dev/null || true
  fi
  pkill -f 'stripe listen' 2>/dev/null || true

  # Clean up the test Clerk user
  delete_clerk_user "${CLERK_USER_ID:-}"

  browser_teardown
}

# ===========================================================================
# Test 1: Sign in via Clerk token on the app domain
# ===========================================================================
@test "sign in via token" {
  echo "# Signing in via token on $APP_URL..." >&3
  agent-browser open "${APP_URL}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  agent-browser wait 5000

  # Wait for token auth to complete — may land on app page or Clerk org creation
  local auth_complete=false
  for _i in $(seq 1 30); do
    local snap
    snap=$(full_snapshot)
    # Org creation page = auth succeeded, user needs to create org first
    if contains "$snap" "Select an Organization\|Create Organization"; then
      auth_complete=true
      break
    fi
    # Normal redirect = already has an org
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if url_is_on_app "$current_url" && [[ ! "$current_url" =~ sign-in-token ]]; then
      auth_complete=true
      break
    fi
    sleep 1
  done

  assert [ "$auth_complete" = "true" ]
  dismiss_cookie_banner
  step_screenshot "after-sign-in"
  echo "# Authentication complete!" >&3
}

# ===========================================================================
# Test 2: Complete onboarding
# ===========================================================================
@test "complete onboarding" {
  echo "# Waiting for onboarding..." >&3
  agent-browser wait 3000

  local snap
  local needs_onboarding=false

  # The test user was created with a Clerk org via API, so Clerk auto-activates
  # the org on sign-in. We only need to wait for the app's onboarding wizard.
  for _i in $(seq 1 30); do
    snap=$(full_snapshot)
    if contains "$snap" "Name your workspace\|Choose your tools\|Connect your apps\|Where would you like to work"; then
      needs_onboarding=true
      break
    fi
    if contains "$snap" "Ask me to automate workflows"; then
      echo "# Already onboarded" >&3
      break
    fi
    sleep 1
  done

  if [[ "$needs_onboarding" != "true" ]]; then
    echo "# Skipping onboarding steps: navigating directly to chat page" >&3
    agent-browser open "$APP_URL" --ignore-https-errors
    agent-browser wait 5000
    step_screenshot "onboarding-skipped"
    return 0
  fi

  # Step 1: Name workspace
  if contains "$snap" "Name your workspace"; then
    echo "# Step 1: Naming workspace..." >&3
    agent-browser find placeholder "e.g. Acme Corp" fill "Pro Upgrade Test"
    agent-browser wait 500
    agent-browser find text "Next" click
    agent-browser wait 2000
    snap=$(full_snapshot)
  fi

  # Step 2: Choose tools (skip)
  if contains "$snap" "Choose your tools"; then
    echo "# Step 2: Choosing tools (skip)..." >&3
    agent-browser find text "Next" click
    agent-browser wait 2000
    snap=$(full_snapshot)
  fi

  # Step 3: Connect apps (skip)
  if contains "$snap" "Connect your apps"; then
    echo "# Step 3: Connect apps (skip)..." >&3
    agent-browser find text "Next" click
    agent-browser wait 2000
    snap=$(full_snapshot)
  fi

  # Step 4: Where to work
  if contains "$snap" "Where would you like to work\|Continue in web"; then
    echo "# Step 4: Continue in web..." >&3
    agent-browser find text "Continue in web" click
    agent-browser wait 8000
  fi

  step_screenshot "onboarding-done"
  echo "# Onboarding complete!" >&3
}

# ===========================================================================
# Test 3: Verify chat page loads and Get Pro button exists
# ===========================================================================
@test "verify chat page with Get Pro button" {
  echo "# Waiting for chat page..." >&3

  agent-browser wait 5000

  local snap
  local chat_loaded=false
  local onboarding_completed_in_loop=false
  for _i in $(seq 1 90); do
    snap=$(full_snapshot)
    if contains "$snap" "Ask me to automate workflows"; then
      chat_loaded=true
      break
    fi
    if contains "$snap" "Ideas.*use cases\|Browse use cases"; then
      chat_loaded=true
      break
    fi
    # Handle onboarding wizard appearing mid-loop (post-org-creation redirect can be slow)
    if [[ "$onboarding_completed_in_loop" != "true" ]] && contains "$snap" "Name your workspace\|Choose your tools\|Connect your apps\|Where would you like to work"; then
      echo "# Onboarding wizard detected in chat polling loop — completing it..." >&3
      if contains "$snap" "Name your workspace"; then
        agent-browser find placeholder "e.g. Acme Corp" fill "Pro Upgrade Test"
        agent-browser wait 500
        agent-browser find text "Next" click
        agent-browser wait 2000
        snap=$(full_snapshot)
      fi
      if contains "$snap" "Choose your tools"; then
        agent-browser find text "Next" click
        agent-browser wait 2000
        snap=$(full_snapshot)
      fi
      if contains "$snap" "Connect your apps"; then
        agent-browser find text "Next" click
        agent-browser wait 2000
        snap=$(full_snapshot)
      fi
      if contains "$snap" "Where would you like to work\|Continue in web"; then
        agent-browser find text "Continue in web" click
        agent-browser wait 8000
      fi
      onboarding_completed_in_loop=true
      echo "# Onboarding completed in loop, continuing to wait for chat page..." >&3
      continue
    fi
    sleep 1
  done
  assert [ "$chat_loaded" = "true" ]

  # Verify "Get Pro" button is visible in sidebar
  local snap_i
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  assert [ "$(contains "$snap_i" "Get Pro" && echo "yes" || echo "no")" = "yes" ]
  step_screenshot "chat-with-get-pro"
  echo "# Chat page loaded with Get Pro button" >&3
}

# ===========================================================================
# Test 4: Click Get Pro and navigate to Stripe checkout
# ===========================================================================
@test "open billing and click Upgrade to Pro" {
  echo "# Clicking Get Pro..." >&3

  # Click "Get Pro" button in sidebar
  local snap_i ref
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  ref=$(echo "$snap_i" | grep -E 'button "Get Pro' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  assert [ -n "$ref" ]
  agent-browser click "$ref"
  agent-browser wait 3000

  # Verify Compare plans dialog
  wait_for_text "Compare plans" 10
  step_screenshot "compare-plans"

  # Click "Upgrade to Pro" — scroll into view first as it may be below the fold
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  ref=$(echo "$snap_i" | grep -E 'button "Upgrade to Pro"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  assert [ -n "$ref" ]
  agent-browser scrollintoview "$ref" 2>/dev/null || true
  agent-browser wait 500
  agent-browser click "$ref"

  # Wait for Stripe checkout page to load (redirect can take 10-20s)
  echo "# Waiting for Stripe checkout page..." >&3
  local stripe_loaded=false
  for _i in $(seq 1 30); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Subscribe to Pro Plan\|subscribe.*pro\|Stripe\|checkout"; then
      stripe_loaded=true
      break
    fi
    sleep 2
  done
  step_screenshot "stripe-checkout"

  assert [ "$stripe_loaded" = "true" ]
  echo "# Stripe checkout page loaded" >&3
}

# ===========================================================================
# Test 5: Fill Stripe test card and subscribe
# ===========================================================================
@test "fill Stripe test card and subscribe" {
  echo "# Filling Stripe checkout form..." >&3

  local snap_i ref

  # Fill email
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  ref=$(echo "$snap_i" | grep -E 'textbox "Email"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  assert [ -n "$ref" ]
  agent-browser fill "$ref" "$E2E_ACCOUNT"
  agent-browser wait 500

  # Select Card payment method — use "Pay with card" button which reliably expands the form
  ref=$(echo "$snap_i" | grep -E 'button "Pay with card"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$ref" ]]; then
    agent-browser click "$ref"
    agent-browser wait 2000
  else
    # Fallback: click radio
    ref=$(echo "$snap_i" | grep -E 'radio "Card"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    if [[ -n "$ref" ]]; then
      agent-browser click "$ref"
      agent-browser wait 2000
    fi
  fi

  # Wait for card form fields to appear
  local card_form_ready=false
  for _i in $(seq 1 10); do
    snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
    if echo "$snap_i" | grep -q 'textbox "Card number"'; then
      card_form_ready=true
      break
    fi
    sleep 1
  done
  assert [ "$card_form_ready" = "true" ]
  echo "# Card form expanded" >&3

  # Fill card details — Stripe test card 4242 4242 4242 4242
  ref=$(echo "$snap_i" | grep -E 'textbox "Card number"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  agent-browser fill "$ref" "4242424242424242"
  agent-browser wait 300

  ref=$(echo "$snap_i" | grep -E 'textbox "Expiration"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  agent-browser fill "$ref" "12/30"
  agent-browser wait 300

  ref=$(echo "$snap_i" | grep -E 'textbox "CVC"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  agent-browser fill "$ref" "123"
  agent-browser wait 300

  ref=$(echo "$snap_i" | grep -E 'textbox "Cardholder name"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  agent-browser fill "$ref" "E2E Test User"
  agent-browser wait 300

  # Fill ZIP code
  ref=$(echo "$snap_i" | grep -E 'textbox "ZIP"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$ref" ]]; then
    agent-browser fill "$ref" "10001"
    agent-browser wait 300
  fi

  # Fill phone number — required when "Save my information" is checked
  # Use agent-browser find which is more reliable than snapshot grep for this field
  echo "# Filling phone number..." >&3
  if agent-browser find placeholder "Phone number" fill "2125551234" 2>/dev/null; then
    echo "# Phone number filled via placeholder" >&3
  elif agent-browser find label "Phone number" fill "2125551234" 2>/dev/null; then
    echo "# Phone number filled via label" >&3
  else
    # Last resort: find by ref in full snapshot
    local full_snap
    full_snap=$(agent-browser snapshot 2>/dev/null || true)
    ref=$(echo "$full_snap" | grep 'textbox "Phone number"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
    if [[ -n "$ref" ]]; then
      agent-browser fill "$ref" "2125551234"
      echo "# Phone number filled via ref" >&3
    else
      echo "# WARNING: Could not find phone number field" >&3
    fi
  fi
  agent-browser wait 300

  step_screenshot "stripe-form-filled"

  # Click Subscribe — scroll into view first as it may be below the fold
  echo "# Clicking Subscribe..." >&3
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  ref=$(echo "$snap_i" | grep -E 'button "Subscribe"' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  assert [ -n "$ref" ]
  agent-browser scrollintoview "$ref" 2>/dev/null || true
  agent-browser wait 500
  agent-browser click "$ref"

  # Wait briefly and check if payment is processing
  agent-browser wait 5000
  step_screenshot "after-subscribe-click"

  # Wait for payment processing and redirect back to app
  echo "# Waiting for payment to process..." >&3
  local redirected=false
  for _i in $(seq 1 60); do
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if url_is_on_app "$current_url"; then
      redirected=true
      break
    fi
    sleep 1
  done
  assert [ "$redirected" = "true" ]

  step_screenshot "after-payment"
  echo "# Payment complete, redirected back to app!" >&3
}

# ===========================================================================
# Test 6: Verify Pro plan is active
# ===========================================================================
@test "verify Pro plan is active" {
  echo "# Waiting for app to load after upgrade..." >&3
  agent-browser wait 5000

  # Wait for sidebar to show "Get Team" (indicates Pro is active)
  local pro_active=false
  for _i in $(seq 1 30); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Get Team"; then
      pro_active=true
      break
    fi
    sleep 1
  done
  step_screenshot "pro-active-sidebar"

  # Also verify via billing settings
  echo "# Opening billing settings to confirm..." >&3
  local snap_i ref
  snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
  ref=$(echo "$snap_i" | grep -E 'button "Get Team' | grep -oE '\[ref=e[0-9]+\]' | head -1 | sed 's/\[ref=/@/; s/\]//')
  if [[ -n "$ref" ]]; then
    agent-browser click "$ref"
    agent-browser wait 3000
  fi

  # Check billing page shows PRO as current plan
  local billing_confirmed=false
  for _i in $(seq 1 10); do
    snap_i=$(agent-browser snapshot -i 2>/dev/null || true)
    # The PRO column should have a disabled "Current plan" button
    if echo "$snap_i" | grep -q 'button "Current plan".*disabled'; then
      local snap
      snap=$(full_snapshot)
      if contains "$snap" "PRO"; then
        billing_confirmed=true
        break
      fi
    fi
    sleep 1
  done
  step_screenshot "billing-pro-confirmed"

  assert [ "$pro_active" = "true" ]
  assert [ "$billing_confirmed" = "true" ]
  echo "# Pro plan upgrade verified!" >&3
}
