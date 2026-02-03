#!/bin/bash
# CLI authentication via API backdoor for CI environments
# Replaces Playwright browser automation with direct API call
# Removes ~200MB Chromium dependency and makes E2E auth faster and more reliable
#
# Prerequisites:
#   - CLI must be installed globally: cd turbo/apps/cli && pnpm link --global
#   - VM0_API_URL environment variable must be set
#   - VERCEL_AUTOMATION_BYPASS_SECRET environment variable for Vercel bypass
#   - USE_MOCK_CLAUDE must be "true" on the server for test-approve endpoint
#
# Usage: ./auth-via-api.sh

set -euo pipefail

# Configuration
TIMEOUT_SECONDS=30
POLL_INTERVAL=1

echo "=== CLI Authentication via API ==="

# Validate environment
if [[ -z "${VM0_API_URL:-}" ]]; then
  echo "Error: VM0_API_URL environment variable is required"
  exit 1
fi

echo "API URL: ${VM0_API_URL}"

# Clean up any existing auth file
rm -f ~/.vm0/config.json

# Create temp file for CLI output
AUTH_OUTPUT=$(mktemp)
trap "rm -f $AUTH_OUTPUT" EXIT

# Start CLI auth login in background
echo "Starting vm0 auth login..."
vm0 auth login > "$AUTH_OUTPUT" 2>&1 &
CLI_PID=$!

# Wait for device code to appear in output
echo "Waiting for device code..."
DEVICE_CODE=""
ELAPSED=0

while [[ -z "$DEVICE_CODE" && $ELAPSED -lt $TIMEOUT_SECONDS ]]; do
  if [[ -f "$AUTH_OUTPUT" ]]; then
    # Extract device code from output (format: "enter this code: XXXX-XXXX")
    # Use grep -o with extended regex for portability (no Perl regex)
    DEVICE_CODE=$(grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' "$AUTH_OUTPUT" 2>/dev/null | head -1 || true)
  fi

  if [[ -z "$DEVICE_CODE" ]]; then
    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
  fi
done

if [[ -z "$DEVICE_CODE" ]]; then
  echo "Error: Failed to get device code after ${TIMEOUT_SECONDS}s"
  echo "CLI output:"
  cat "$AUTH_OUTPUT"
  kill $CLI_PID 2>/dev/null || true
  exit 1
fi

# Mask device code in logs (show first 2 and last 2 chars only)
MASKED_CODE="${DEVICE_CODE:0:2}**-**${DEVICE_CODE: -2}"
echo "Got device code: $MASKED_CODE"

# Build curl headers
CURL_HEADERS=(-H "Content-Type: application/json")
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  CURL_HEADERS+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
fi

# Call test-approve endpoint
echo "Calling test-approve endpoint..."
RESPONSE=$(curl -s -w "\n%{http_code}" \
  "${CURL_HEADERS[@]}" \
  -X POST \
  -d "{\"device_code\": \"$DEVICE_CODE\"}" \
  "${VM0_API_URL}/api/cli/auth/test-approve")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: test-approve endpoint returned $HTTP_CODE"
  echo "Response: $BODY"
  kill $CLI_PID 2>/dev/null || true
  exit 1
fi

echo "Device code approved"

# Wait for CLI to complete (it should poll and get the token)
echo "Waiting for CLI to complete authentication..."
WAIT_RESULT=0
wait $CLI_PID || WAIT_RESULT=$?

# Check if auth was successful
if [[ -f ~/.vm0/config.json ]] && grep -q '"token"' ~/.vm0/config.json 2>/dev/null; then
  echo ""
  echo "=== Authentication successful ==="
  echo "Auth file: ~/.vm0/config.json"
  exit 0
else
  echo "Error: Authentication may have failed"
  echo "CLI exit code: $WAIT_RESULT"
  echo "CLI output:"
  cat "$AUTH_OUTPUT"
  exit 1
fi
