#!/usr/bin/env bats
# brw-t03-onboarding-chat.bats — Verify onboarding flow leads to chat page
#
# Tests the full user flow: sign in via Clerk token on platform app →
# onboarding wizard → chat interface. Uses the platform's /sign-in-token
# route so authentication happens directly on the app domain (no cross-domain
# session sharing needed).
#
# Required env vars:
#   VM0_API_URL        — Target web app URL (e.g., https://www.vm7.ai:8443)
#   CLERK_SECRET_KEY   — Clerk Backend API key (for creating sign-in tokens)

load '../../helpers/setup'
load '../../helpers/browser'

# ---------------------------------------------------------------------------
# url_is_on_app — Check if a URL's hostname matches the APP_URL hostname
# Compares against the derived APP_URL rather than assuming "app." prefix,
# so it works for all environments (app.vm7.ai, staging-app.vm6.ai, etc.)
# ---------------------------------------------------------------------------
url_is_on_app() {
  local url="$1"
  local url_host app_host
  url_host=$(echo "$url" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  app_host=$(echo "$APP_URL" | sed -n 's|.*://\([^/:]*\).*|\1|p')
  [[ "$url_host" == "$app_host" ]]
}

setup_file() {
  browser_setup
  create_clerk_sign_in_token

  APP_URL="$(derive_app_url)"
  export APP_URL

  echo "# Onboarding → Chat flow verification via agent-browser" >&3
  echo "#   Web URL: $VM0_API_URL" >&3
  echo "#   App URL: $APP_URL" >&3
}

teardown_file() {
  browser_teardown
}

@test "sign in via token on platform app" {
  # Navigate to platform's /sign-in-token route — authenticates directly
  # on the app domain, avoiding cross-domain session issues
  echo "# Signing in via token on platform app..." >&3
  agent-browser open "${APP_URL}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  agent-browser wait 5000
  step_screenshot "sign-in-token"

  # Wait for token auth to complete and redirect away from /sign-in-token
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

  # Dismiss cookie banner if present
  dismiss_cookie_banner
}

@test "detect and complete onboarding" {
  # Wait for platform content to load
  echo "# Waiting for platform content..." >&3
  agent-browser wait 3000

  local snap
  local needs_onboarding=false

  for _i in $(seq 1 20); do
    snap=$(full_snapshot)
    if contains "$snap" "Name your workspace\|Choose your tools\|Connect your apps\|Where would you like to work"; then
      needs_onboarding=true
      break
    fi
    if contains "$snap" "Ask me to automate workflows\|Ideas.*use cases\|Browse use cases"; then
      echo "# Already onboarded — chat page detected" >&3
      break
    fi
    sleep 1
  done
  step_screenshot "platform-state"

  if [[ "$needs_onboarding" != "true" ]]; then
    echo "# Skipping onboarding: user already onboarded" >&3
    skip "User already onboarded"
  fi

  # --- Step 1: Name your workspace ---
  if contains "$snap" "Name your workspace"; then
    echo "# Step 1: Naming workspace..." >&3
    step_screenshot "onboard-step1"
    agent-browser find placeholder "e.g. Acme Corp" fill "E2E Test Workspace"
    agent-browser wait 500
    agent-browser find text "Next" click
    agent-browser wait 2000
    step_screenshot "onboard-step1-done"
    snap=$(full_snapshot)
  fi

  # --- Step 2: Choose your tools ---
  if contains "$snap" "Choose your tools"; then
    echo "# Step 2: Choosing tools (skip, click Next)..." >&3
    step_screenshot "onboard-step2"
    agent-browser find text "Next" click
    agent-browser wait 2000
    step_screenshot "onboard-step2-done"
    snap=$(full_snapshot)
  fi

  # --- Step 3: Connect your apps ---
  if contains "$snap" "Connect your apps"; then
    echo "# Step 3: Connect apps (skip, click Next)..." >&3
    step_screenshot "onboard-step3"
    agent-browser find text "Next" click
    agent-browser wait 2000
    step_screenshot "onboard-step3-done"
    snap=$(full_snapshot)
  fi

  # --- Step 4: Where to work ---
  if contains "$snap" "Where would you like to work\|Continue in web"; then
    echo "# Step 4: Choosing 'Continue in web'..." >&3
    step_screenshot "onboard-step4"
    agent-browser find text "Continue in web" click
    agent-browser wait 8000
    step_screenshot "onboard-step4-done"
  fi

  echo "# Onboarding complete!" >&3
}

@test "verify chat page is displayed" {
  echo "# Verifying chat page..." >&3

  local chat_loaded=false
  for _i in $(seq 1 30); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Ask me to automate workflows"; then
      chat_loaded=true
      break
    fi
    if contains "$snap" "Ideas.*use cases\|Browse use cases"; then
      chat_loaded=true
      break
    fi
    sleep 1
  done
  step_screenshot "chat-page-final"

  assert [ "$chat_loaded" = "true" ]

  # Verify URL is on the platform app domain
  local final_url
  final_url=$(agent-browser get url 2>/dev/null || true)
  echo "# Final URL: $final_url" >&3
  url_is_on_app "$final_url"
  [[ ! "$final_url" =~ sign-in ]]
  [[ ! "$final_url" =~ onboarding ]]
}
