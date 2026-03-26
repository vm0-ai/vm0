#!/usr/bin/env bats
# brw-t02-token-auth.bats — Verify Clerk token-based auth reaches app homepage
#
# Required env vars:
#   VM0_API_URL        — Target site URL
#   CLERK_SECRET_KEY   — Clerk Backend API key (for creating sign-in tokens)

load '../../helpers/setup'
load '../../helpers/browser'

setup_file() {
  browser_setup
  create_clerk_sign_in_token

  echo "# Token-based auth verification via agent-browser" >&3
  echo "#   URL:   $VM0_API_URL" >&3
}

teardown_file() {
  browser_teardown
}

@test "sign in via Clerk token and reach app homepage" {
  # Navigate to sign-in-token page with the token
  echo "# Navigating to sign-in-token page" >&3
  agent-browser open "${VM0_API_URL}/sign-in-token?token=${SIGN_IN_TOKEN}" --ignore-https-errors
  agent-browser wait 3000
  step_screenshot "sign-in-token-page"

  # Wait for redirect chain to complete (/sign-in-token -> / -> /en)
  echo "# Waiting for redirect to complete..." >&3
  local redirect_complete=false
  for i in $(seq 1 20); do
    local current_url
    current_url=$(agent-browser get url 2>/dev/null || true)
    if [[ -n "$current_url" && ! "$current_url" =~ sign-in-token ]]; then
      redirect_complete=true
      break
    fi
    sleep 1
  done
  step_screenshot "after-redirect"
  assert [ "$redirect_complete" = "true" ]

  # Dismiss cookie banner if present
  dismiss_cookie_banner

  # Wait for page content to load and verify signed-in state
  echo "# Verifying authenticated homepage..." >&3
  local signed_in=false
  for i in $(seq 1 10); do
    local snap
    snap=$(full_snapshot)
    if contains "$snap" "Open app"; then
      signed_in=true
      break
    fi
    sleep 1
  done
  step_screenshot "homepage-final"

  # Assert signed-in state
  assert [ "$signed_in" = "true" ]

  # Assert URL does not contain sign-in-token (redirect completed)
  local final_url
  final_url=$(agent-browser get url 2>/dev/null || true)
  [[ ! "$final_url" =~ sign-in-token ]]
}
